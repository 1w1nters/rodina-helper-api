const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Подключение к базе данных PostgreSQL на Render
// URL будет добавлен позже через переменные окружения
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware для обработки JSON и разрешения CORS-запросов
app.use(cors());
app.use(express.json());

// --- API ЭНДПОИНТЫ ---

app.post('/api/actions/report-action', async (req, res) => {
    const { userId, actionType } = req.body;
    if (!userId || !actionType) {
        return res.status(400).json({ message: 'Необходимы userId и actionType.' });
    }

    try {
        const userRes = await pool.query('SELECT progress FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) throw new Error('Пользователь не найден.');

        const progress = userRes.rows[0].progress || { achievements: {} };
        if (!progress.achievements) progress.achievements = {};

        let achievementGranted = false;

        // Определяем, какое достижение выдать
        switch (actionType) {
            case 'sent_feedback':
                if (!progress.achievements['pioneer']) {
                    progress.achievements['pioneer'] = { grantedAt: Date.now() };
                    achievementGranted = true;
                }
                break;
            case 'used_removal_tool':
                if (!progress.achievements['archivist']) {
                    progress.achievements['archivist'] = { grantedAt: Date.now() };
                    achievementGranted = true;
                }
                break;
        }

        if (achievementGranted) {
            await pool.query('UPDATE users SET progress = $1 WHERE id = $2', [progress, userId]);
            console.log(`[SERVER] Пользователю ${userId} выдано достижение за действие "${actionType}".`);
        }
        
        res.status(200).json({ success: true });

    } catch (error) {
        console.error(`Ошибка при обработке действия "${actionType}":`, error);
        res.status(500).json({ message: 'Внутренняя ошибка сервера.' });
    }
});


// --- НОВЫЙ ЭНДПОИНТ ДЛЯ ПРОВЕРКИ ЕЖЕДНЕВНЫХ ДОСТИЖЕНИЙ ---
app.post('/api/actions/check-daily', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ message: 'Необходим userId.' });
    }
    const DAY_IN_MS = 24 * 60 * 60 * 1000;

    try {
        const userRes = await pool.query('SELECT created_at, progress FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) throw new Error('Пользователь не найден.');

        const { created_at, progress: currentProgress } = userRes.rows[0];
        const progress = currentProgress || { achievements: {} };
        if (!progress.achievements) progress.achievements = {};

        const installDate = new Date(created_at).getTime();
        const daysUsed = Math.floor((Date.now() - installDate) / DAY_IN_MS);
        let changed = false;

        const dayAchievements = { 'days_1': 1, 'days_7': 7, 'days_30': 30 };

        for (const [achId, requiredDays] of Object.entries(dayAchievements)) {
            if (daysUsed >= requiredDays && !progress.achievements[achId]) {
                progress.achievements[achId] = { grantedAt: Date.now() };
                changed = true;
                console.log(`[SERVER] Пользователю ${userId} выдано достижение за дни: "${achId}".`);
            }
        }

        if (changed) {
            await pool.query('UPDATE users SET progress = $1 WHERE id = $2', [progress, userId]);
        }

        res.status(200).json({ success: true, achievements: progress.achievements });

    } catch (error) {
        console.error('Ошибка при ежедневной проверке достижений:', error);
        res.status(500).json({ message: 'Внутренняя ошибка сервера.' });
    }
});

// 1. Регистрация или получение пользователя
app.post('/api/user/auth', async (req, res) => {
    // ИЗМЕНЕНИЕ: Добавляем adminLevel из запроса
    const { forumId, nickname, adminLevel } = req.body;
    if (!forumId || !nickname) {
        return res.status(400).json({ message: 'Forum ID and nickname are required.' });
    }

    try {
        let userResult = await pool.query('SELECT * FROM users WHERE forum_id = $1', [forumId]);
        let user = userResult.rows[0];

        if (user) {
            // ИЗМЕНЕНИЕ: Обновляем не только ник, но и уровень администратора
            await pool.query(
                'UPDATE users SET nickname = $1, last_seen = NOW(), admin_level = $2 WHERE forum_id = $3', 
                [nickname, adminLevel || 0, forumId]
            );
            console.log(`User ${nickname} found and updated with admin level ${adminLevel}.`);
        } else {
            // ИЗМЕНЕНИЕ: Добавляем уровень администратора при создании нового пользователя
            const insertResult = await pool.query(
                'INSERT INTO users (forum_id, nickname, admin_level, created_at, last_seen, progress) VALUES ($1, $2, $3, NOW(), NOW(), $4) RETURNING *',
                [forumId, nickname, adminLevel || 0, JSON.stringify({ installDate: Date.now(), achievements: {}, complaintHistory: [] })]
            );
            user = insertResult.rows[0];
            console.log(`User ${nickname} created with admin level ${adminLevel}.`);
        }
        // Получаем свежие данные пользователя после обновления/создания
        const finalUserResult = await pool.query('SELECT * FROM users WHERE forum_id = $1', [forumId]);
        res.status(200).json(finalUserResult.rows[0]);

    } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ message: 'Server error during authentication.' });
    }
});

// 2. Получение данных пользователя (прогресс и настройки)
app.get('/api/user/data/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query('SELECT progress, settings, last_sync FROM users WHERE id = $1', [userId]);
        if (result.rows.length > 0) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'User data not found.' });
        }
    } catch (err) {
        console.error('Get user data error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// 3. Сохранение данных пользователя
app.post('/api/user/data/:userId', async (req, res) => {
    const { userId } = req.params;
    const { progress, settings } = req.body;

    try {
        // --- НАЧАЛО НОВОЙ ЛОГИКИ: Проверка достижений за жалобы ---
        if (progress && progress.complaintHistory) {
            // Сначала получаем текущий прогресс из БД, чтобы ничего не затереть
            const userRes = await pool.query('SELECT progress FROM users WHERE id = $1', [userId]);
            const existingProgress = userRes.rows[0]?.progress || { achievements: {} };
            if (!existingProgress.achievements) existingProgress.achievements = {};

            // Объединяем ачивки
            progress.achievements = { ...existingProgress.achievements, ...progress.achievements };

            const complaintCount = progress.complaintHistory.length;
            const complaintAchievements = { 'complaints_10': 10, 'complaints_50': 50, 'complaints_100': 100 };
            
            for (const [achId, requiredCount] of Object.entries(complaintAchievements)) {
                if (complaintCount >= requiredCount && !progress.achievements[achId]) {
                    progress.achievements[achId] = { grantedAt: Date.now() };
                    console.log(`[SERVER] Пользователю ${userId} выдано достижение за жалобы: "${achId}".`);
                }
            }
        }
        // --- КОНЕЦ НОВОЙ ЛОГИКИ ---

        // Используем оператор || для "умного" объединения JSONB данных.
        if (progress) {
            await pool.query('UPDATE users SET progress = progress || $1 WHERE id = $2', [progress, userId]);
        }
        if (settings) {
            await pool.query('UPDATE users SET settings = settings || $1, last_sync = NOW() WHERE id = $2', [settings, userId]);
        }
        
        const result = await pool.query('SELECT last_sync FROM users WHERE id = $1', [userId]);
        res.status(200).json({ message: 'Data saved successfully.', lastSyncTimestamp: result.rows[0]?.last_sync });

    } catch (err) {
        console.error('Save user data error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// 4. Получение лидербордов
app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const result = await pool.query("SELECT nickname, progress FROM users WHERE jsonb_array_length(progress->'complaintHistory') > 0");
        
        const users = result.rows.map(row => {
            // --- НАЧАЛО ИЗМЕНЕНИЙ ---
            // Проверяем, что history существует и является массивом
            const history = Array.isArray(row.progress.complaintHistory) ? row.progress.complaintHistory : [];
            // --- КОНЕЦ ИЗМЕНЕНИЙ ---
            
            const now = Date.now();
            const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
            const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

            return {
                nickname: row.nickname,
                // --- НАЧАЛО ИЗМЕНЕНИЙ ---
                // Добавляем проверку, что у элемента есть timestamp
                weeklyCount: history.filter(item => item && item.timestamp && item.timestamp >= oneWeekAgo).length,
                monthlyCount: history.filter(item => item && item.timestamp && item.timestamp >= oneMonthAgo).length
                // --- КОНЕЦ ИЗМЕНЕНИЙ ---
            };
        });

        const weekly = [...users].sort((a, b) => b.weeklyCount - a.weeklyCount).slice(0, 10);
        const monthly = [...users].sort((a, b) => b.monthlyCount - a.monthlyCount).slice(0, 10);

        res.status(200).json({ weekly, monthly });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// 5. Heartbeat - обновление статуса "онлайн"
app.post('/api/heartbeat', async (req, res) => {
    // ИЗМЕНЕНИЕ: Принимаем userId и adminLevel
    const { userId, adminLevel } = req.body;
    if (!userId) {
        return res.status(400).send();
    }
    try {
        // ИЗМЕНЕНИЕ: Собираем запрос динамически
        let query = 'UPDATE users SET last_seen = NOW()';
        const queryParams = [userId];

        // Если в heartbeat пришел adminLevel, обновляем и его тоже
        if (adminLevel !== undefined && adminLevel !== null) {
            queryParams.unshift(adminLevel); // Добавляем в начало массива параметров
            query += ', admin_level = $1 WHERE id = $2';
        } else {
            query += ' WHERE id = $1';
        }
        
        // Выполняем запрос с правильным количеством параметров
        await pool.query(query, queryParams.reverse());

        res.status(200).send();
    } catch (err) {
        console.error('Heartbeat error:', err);
        res.status(500).send();
    }
});


// 6. Получение списка всех пользователей
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nickname FROM users ORDER BY nickname ASC');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Get user list error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// 7. Получение публичного профиля пользователя
app.get('/api/users/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        // Выбираем только публичные данные
        const result = await pool.query(
            "SELECT id, nickname, forum_id, progress->'complaintHistory' as complaintHistory, progress->'installDate' as installDate FROM users WHERE id = $1",
            [userId]
        );
        if (result.rows.length > 0) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'User profile not found.' });
        }
    } catch (err) {
        console.error('Get user profile error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// 8. Получение статуса онлайн для списка пользователей
app.post('/api/users/status', async (req, res) => {
    const { forum_ids } = req.body;
    if (!Array.isArray(forum_ids) || forum_ids.length === 0) {
        return res.status(200).json([]);
    }
    try {
        // Ищем пользователей, которые были онлайн в последние 3 минуты
        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
        const result = await pool.query(
            'SELECT forum_id FROM users WHERE forum_id = ANY($1) AND last_seen > $2',
            [forum_ids, threeMinutesAgo]
        );
        const onlineIds = result.rows.map(row => row.forum_id);
        res.status(200).json(onlineIds);
    } catch (err) {
        console.error('Get online status error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// Запуск сервера
// Запуск сервера
app.listen(port, async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                forum_id VARCHAR(20) UNIQUE NOT NULL,
                nickname VARCHAR(50) NOT NULL,
                created_at TIMESTAMPTZ,
                last_seen TIMESTAMPTZ,
                last_sync TIMESTAMPTZ,
                progress JSONB,
                settings JSONB,
                admin_level INTEGER DEFAULT 0 -- ИЗМЕНЕНИЕ: Добавлена новая колонка
            );
        `);
        console.log('Database table "users" schema check complete.');

        // ИЗМЕНЕНИЕ: Добавляем колонку, если она еще не существует (для уже созданных таблиц)
        try {
            await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_level INTEGER DEFAULT 0;');
            console.log('Column "admin_level" is present in the "users" table.');
        } catch (alterErr) {
            console.error('Could not ensure admin_level column exists:', alterErr);
        }

        console.log(`Server is running on port ${port}`);

    } catch (err) {
        console.error('Database initialization error:', err);
    }
});
