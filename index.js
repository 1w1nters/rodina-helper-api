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

const ACHIEVEMENTS = {
    // Достижения за дни использования
    'days_1': { id: 'days_1', name: 'Новичок', description: '1 день с Rodina Helper. Добро пожаловать!', icon: 'user-plus' },
    'days_7': { id: 'days_7', name: 'Освоившийся', description: '7 дней с Rodina Helper. Вы уже освоились!', icon: 'rocket' },
    'days_30': { id: 'days_30', name: 'Ветеран', description: '30 дней с Rodina Helper. Вы - часть команды!', icon: 'crown' },

    // Достижения за количество проверенных жалоб
    'complaints_10': { id: 'complaints_10', name: 'Первые шаги', description: 'Рассмотрено 10 жалоб. Отличное начало!', icon: 'baby' },
    'complaints_50': { id: 'complaints_50', name: 'Работник месяца', description: 'Рассмотрено 50 жалоб. Так держать!', icon: 'hand-peace' },
    'complaints_100': { id: 'complaints_100', name: 'Страж порядка', description: 'Рассмотрено 100 жалоб. Справедливость восторжествует!', icon: 'user-shield' },
    
    // Достижения за использование функций
    'pioneer': { id: 'pioneer', name: 'Неравнодушный', description: 'Отправили свой первый отчет об ошибке или предложение. Спасибо за помощь!', icon: 'handshake-angle' },
    'archivist': { id: 'archivist', name: 'Архивариус', description: 'Воспользовались функцией снятия администратора. Важная и ответственная процедура.', icon: 'edit' }
};

app.post('/api/actions/report-action', async (req, res) => {
    const { userId, actionType, value } = req.body;

    if (!userId || !actionType) {
        return res.status(400).json({ message: 'User ID and action type are required.' });
    }

    try {
        const userResult = await pool.query("SELECT progress FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const userProgress = userResult.rows[0].progress || { achievements: {}, complaintHistory: [] };
        const achievements = userProgress.achievements || {};
        const awardedAchievements = [];

        // Логика проверки достижений
        switch (actionType) {
            case 'sent_feedback':
                if (!achievements.pioneer) {
                    achievements.pioneer = { grantedAt: Date.now() };
                    awardedAchievements.push(ACHIEVEMENTS.pioneer);
                }
                break;
            
            case 'used_removal_tool':
                if (!achievements.archivist) {
                    achievements.archivist = { grantedAt: Date.now() };
                    awardedAchievements.push(ACHIEVEMENTS.archivist);
                }
                break;

            case 'processed_complaint':
                const complaintCount = value || 0;
                const complaintAchievements = Object.values(ACHIEVEMENTS).filter(a => a.id.startsWith('complaints_'));
                for (const ach of complaintAchievements) {
                    if (complaintCount >= ach.req && !achievements[ach.id]) {
                        achievements[ach.id] = { grantedAt: Date.now() };
                        awardedAchievements.push(ach);
                    }
                }
                break;
            
            case 'daily_check':
                const installDate = userProgress.installDate || Date.now();
                const daysUsed = Math.floor((Date.now() - installDate) / (1000 * 60 * 60 * 24));
                const dailyAchievements = Object.values(ACHIEVEMENTS).filter(a => a.id.startsWith('days_'));
                for (const ach of dailyAchievements) {
                     if (daysUsed >= ach.req && !achievements[ach.id]) {
                        achievements[ach.id] = { grantedAt: Date.now() };
                        awardedAchievements.push(ach);
                    }
                }
                break;
        }

        // Если были выданы новые достижения, обновляем запись в БД
        if (awardedAchievements.length > 0) {
            await pool.query("UPDATE users SET progress = jsonb_set(progress, '{achievements}', $1::jsonb) WHERE id = $2", [
                JSON.stringify(achievements),
                userId
            ]);
            console.log(`User ${userId} was awarded achievements: ${awardedAchievements.map(a => a.name).join(', ')}`);
        }
        
        // Отправляем клиенту список только что полученных достижений
        res.status(200).json({ awardedAchievements });

    } catch (err) {
        console.error('Report action error:', err);
        res.status(500).json({ message: 'Server error during action report.' });
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
        // Используем оператор || для "умного" объединения JSONB данных.
        // Это сохранит существующие поля и обновит/добавит только новые.
        if (progress) {
            await pool.query('UPDATE users SET progress = progress || $1 WHERE id = $2', [progress, userId]);
        }
        if (settings) {
            await pool.query('UPDATE users SET settings = settings || $1, last_sync = NOW() WHERE id = $2', [settings, userId]);
        }
        
        const result = await pool.query('SELECT last_sync FROM users WHERE id = $1', [userId]);
        // Добавлена проверка на случай, если result.rows[0] не существует
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








