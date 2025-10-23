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

// 1. Регистрация или получение пользователя
app.post('/api/user/auth', async (req, res) => {
    const { forumId, nickname } = req.body;
    if (!forumId || !nickname) {
        return res.status(400).json({ message: 'Forum ID and nickname are required.' });
    }

    try {
        // Пытаемся найти пользователя
        let userResult = await pool.query('SELECT * FROM users WHERE forum_id = $1', [forumId]);
        let user = userResult.rows[0];

        if (user) {
            // Если пользователь найден, обновляем его ник на всякий случай и дату последнего визита
            await pool.query('UPDATE users SET nickname = $1, last_seen = NOW() WHERE forum_id = $2', [nickname, forumId]);
            console.log(`User ${nickname} found and updated.`);
        } else {
            // Если не найден, создаем нового
            const insertResult = await pool.query(
                'INSERT INTO users (forum_id, nickname, created_at, last_seen, progress) VALUES ($1, $2, NOW(), NOW(), $3) RETURNING *',
                [forumId, nickname, JSON.stringify({ installDate: Date.now(), achievements: {}, complaintHistory: [] })]
            );
            user = insertResult.rows[0];
            console.log(`User ${nickname} created.`);
        }
        res.status(200).json(user);

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
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).send();
    }
    try {
        await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
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
        // Создаем таблицу, только если она не существует. Этого достаточно.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                forum_id VARCHAR(20) UNIQUE NOT NULL,
                nickname VARCHAR(50) NOT NULL,
                created_at TIMESTAMPTZ,
                last_seen TIMESTAMPTZ,
                last_sync TIMESTAMPTZ,
                progress JSONB,
                settings JSONB
            );
        `);

        console.log('Database table "users" is ready.');
        console.log(`Server is running on port ${port}`);

    } catch (err) {
        console.error('Database initialization error:', err);
    }
});





