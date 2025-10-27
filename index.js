// index.js - ИСПРАВЛЕННАЯ И АДАПТИРОВАННАЯ ВЕРСИЯ ДЛЯ RODINA HELPER

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Подключение к базе данных PostgreSQL на Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// --- API ЭНДПОИНТЫ ДЛЯ RODINA HELPER ---

// 1. Авторизация/Регистрация пользователя
app.post('/api/user/auth', async (req, res) => {
    const { forumId, nickname, adminLevel } = req.body;
    if (!forumId || !nickname) {
        return res.status(400).json({ message: 'Forum ID and nickname are required.' });
    }

    try {
        let userResult = await pool.query('SELECT * FROM users WHERE forum_id = $1', [forumId]);
        let user = userResult.rows[0];

        if (user) {
            // Обновляем существующего пользователя
            await pool.query(
                'UPDATE users SET nickname = $1, last_seen = NOW(), admin_level = $2 WHERE forum_id = $3', 
                [nickname, adminLevel || 0, forumId]
            );
            console.log(`User ${nickname} (Rodina) found and updated with admin level ${adminLevel}.`);
        } else {
            // Создаем нового пользователя
            const insertResult = await pool.query(
                'INSERT INTO users (forum_id, nickname, admin_level, created_at, last_seen) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
                [forumId, nickname, adminLevel || 0]
            );
            user = insertResult.rows[0];
            console.log(`User ${nickname} (Rodina) created with admin level ${adminLevel}.`);
        }
        
        // Возвращаем актуальные данные пользователя, включая среднее время
        const finalUserResult = await pool.query(
            `SELECT *, 
            (progress->'stats'->>'totalCheckTime')::numeric / NULLIF((progress->'stats'->>'totalChecks')::numeric, 0) as "averageCheckTime"
            FROM users WHERE forum_id = $1`, 
            [forumId]
        );
        res.status(200).json(finalUserResult.rows[0]);

    } catch (err) {
        console.error('Rodina Auth error:', err);
        res.status(500).json({ message: 'Server error during authentication.' });
    }
});

// 2. Получение данных пользователя (прогресс)
app.get('/api/user/data/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query('SELECT progress FROM users WHERE id = $1', [userId]);
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

// 3. Сохранение данных пользователя (прогресс) - ОСТАВЛЯЕМ ДЛЯ ОБЩЕЙ СИНХРОНИЗАЦИИ
app.post('/api/user/data/:userId', async (req, res) => {
    const { userId } = req.params;
    const { progress } = req.body;
    if (!progress) {
        return res.status(400).json({ message: 'Progress data is required.' });
    }
    try {
        await pool.query('UPDATE users SET progress = $1 WHERE id = $2', [progress, userId]);
        res.status(200).json({ message: 'Data saved successfully.' });
    } catch (err) {
        console.error('Save user data error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});


// --- НАЧАЛО ГЛАВНОГО ИЗМЕНЕНИЯ ---

// НОВЫЙ ЭНДПОИНТ ДЛЯ ДОБАВЛЕНИЯ ОДНОЙ ЖАЛОБЫ
app.post('/api/complaints/add', async (req, res) => {
    const { userId, threadId } = req.body;
    if (!userId || !threadId) {
        return res.status(400).json({ message: 'userId и threadId обязательны.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Получаем текущий прогресс пользователя
        const userRes = await client.query('SELECT progress FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userRes.rows.length === 0) {
            throw new Error('Пользователь не найден.');
        }

        let progress = userRes.rows[0].progress || {};
        // Инициализируем поля, если их нет
        progress.complaintHistory = progress.complaintHistory || [];
        progress.activityLog = progress.activityLog || [];
        progress.achievements = progress.achievements || {};

        // 2. Добавляем новую жалобу в историю
        progress.complaintHistory.push({
            threadId: threadId,
            timestamp: Date.now(),
        });

        // 3. Добавляем запись в лог активности
        const newLogEntry = {
            type: 'complaint',
            details: { threadId: threadId },
            timestamp: Date.now()
        };
        progress.activityLog.unshift(newLogEntry);
        if (progress.activityLog.length > 50) {
            progress.activityLog.length = 50;
        }

        // 4. Проверяем достижения за жалобы прямо здесь, на сервере
        const complaintCount = progress.complaintHistory.length;
        const complaintAchievements = { 'complaints_10': 10, 'complaints_50': 50, 'complaints_100': 100 };

        for (const [achId, requiredCount] of Object.entries(complaintAchievements)) {
            if (complaintCount >= requiredCount && !progress.achievements[achId]) {
                progress.achievements[achId] = { grantedAt: Date.now() };
            }
        }

        // 5. Сохраняем обновленный объект progress в базу данных
        await client.query('UPDATE users SET progress = $1 WHERE id = $2', [progress, userId]);
        await client.query('COMMIT');

        console.log(`[SERVER] Успешно обработана жалоба #${threadId} для пользователя ${userId}.`);
        
        // 6. Возвращаем клиенту самый актуальный и полный объект progress
        res.status(200).json({ success: true, progress: progress });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[SERVER] Ошибка при обработке жалобы #${threadId}:`, error);
        res.status(500).json({ message: 'Внутренняя ошибка сервера.' });
    } finally {
        client.release();
    }
});

// --- КОНЕЦ ГЛАВНОГО ИЗМЕНЕНИЯ ---


// 4. Получение лидербордов
app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const result = await pool.query("SELECT nickname, progress FROM users WHERE progress->'complaintHistory' IS NOT NULL");
        
        const users = result.rows.map(row => {
            const history = Array.isArray(row.progress?.complaintHistory) ? row.progress.complaintHistory : [];
            const now = Date.now();
            const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
            const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

            return {
                nickname: row.nickname,
                weeklyCount: history.filter(item => item?.timestamp >= oneWeekAgo).length,
                monthlyCount: history.filter(item => item?.timestamp >= oneMonthAgo).length
            };
        });

        const weekly = users.sort((a, b) => b.weeklyCount - a.weeklyCount).slice(0, 10);
        const monthly = users.sort((a, b) => b.monthlyCount - a.monthlyCount).slice(0, 10);

        res.status(200).json({ weekly, monthly });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// 5. Heartbeat
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

// 7. Получение публичного профиля
app.get('/api/users/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT 
                id, 
                nickname, 
                forum_id, 
                created_at, 
                admin_level, 
                COALESCE(progress->'complaintHistory', '[]'::jsonb) as "complaintHistory", 
                COALESCE(progress->'achievements', '{}'::jsonb) as "achievements", 
                COALESCE(progress->'activityLog', '[]'::jsonb) as "activityLog",
                (progress->'stats'->>'totalCheckTime')::numeric / NULLIF((progress->'stats'->>'totalChecks')::numeric, 0) as "averageCheckTime"
            FROM users WHERE id = $1`,
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

// 8. Получение статуса онлайн
app.post('/api/users/status', async (req, res) => {
    const { forum_ids } = req.body;
    if (!Array.isArray(forum_ids) || forum_ids.length === 0) {
        return res.status(200).json([]);
    }
    try {
        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
        const result = await pool.query(
            'SELECT forum_id FROM users WHERE forum_id = ANY($1::text[]) AND last_seen > $2',
            [forum_ids, threeMinutesAgo]
        );
        const onlineIds = result.rows.map(row => row.forum_id);
        res.status(200).json(onlineIds);
    } catch (err) {
        console.error('Get online status error:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// index.js

app.post('/api/stats/check-time', async (req, res) => {
    const { userId, duration } = req.body; // duration в секундах
    if (!userId || typeof duration !== 'number') {
        return res.status(400).json({ message: 'userId и duration обязательны.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT progress FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userRes.rows.length === 0) {
            throw new Error('Пользователь не найден.');
        }

        let progress = userRes.rows[0].progress || {};
        if (!progress.stats) {
            progress.stats = { totalCheckTime: 0, totalChecks: 0 };
        }

        progress.stats.totalCheckTime = (progress.stats.totalCheckTime || 0) + duration;
        progress.stats.totalChecks = (progress.stats.totalChecks || 0) + 1;

        await client.query('UPDATE users SET progress = $1 WHERE id = $2', [progress, userId]);
        await client.query('COMMIT');
        
        // --- НАЧАЛО ИЗМЕНЕНИЯ ---
        const newAverageTime = progress.stats.totalCheckTime / progress.stats.totalChecks;
        console.log(`[SERVER] Записано время проверки ${duration} сек. для пользователя ${userId}. Новое среднее: ${newAverageTime}`);
        res.status(200).json({ success: true, message: 'Время проверки записано.', newAverageTime: newAverageTime });
        // --- КОНЕЦ ИЗМЕНЕНИЯ ---

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[SERVER] Ошибка при записи времени проверки для пользователя ${userId}:`, error);
        res.status(500).json({ message: 'Внутренняя ошибка сервера.' });
    } finally {
        client.release();
    }
});


// 9. Регистрация действия и выдача ачивки
app.post('/api/actions/report-action', async (req, res) => {
    const { userId, actionType } = req.body;
    if (!userId || !actionType) {
        return res.status(400).json({ message: 'Необходимы userId и actionType.' });
    }

    try {
        const userRes = await pool.query('SELECT progress FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) throw new Error('Пользователь не найден.');

        let progress = userRes.rows[0].progress || { achievements: {} };
        if (!progress.achievements) progress.achievements = {};

        let achievementGranted = false;
        
        const achievementsMap = {
            'sent_feedback': 'pioneer',
            'used_removal_tool': 'archivist'
        };

        const achId = achievementsMap[actionType];

        if (achId && !progress.achievements[achId]) {
            progress.achievements[achId] = { grantedAt: Date.now() };
            achievementGranted = true;
        }

        if (achievementGranted) {
            await pool.query('UPDATE users SET progress = $1 WHERE id = $2', [progress, userId]);
            console.log(`[SERVER] Пользователю ${userId} выдано достижение за действие "${actionType}".`);
        }
        
        // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
        // Возвращаем полный объект progress, чтобы клиент мог немедленно обновиться
        res.status(200).json({ success: true, newAchievement: achievementGranted, progress: progress });

    } catch (error) {
        console.error(`Ошибка при обработке действия "${actionType}":`, error);
        res.status(500).json({ message: 'Внутренняя ошибка сервера.' });
    }
});

// 10. Проверка ежедневных достижений
app.post('/api/actions/check-daily', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ message: 'Необходим userId.' });
    }
    const DAY_IN_MS = 24 * 60 * 60 * 1000;

    try {
        const userRes = await pool.query('SELECT created_at, progress FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) throw new Error('Пользователь не найден.');

        let { created_at, progress } = userRes.rows[0];
        progress = progress || { achievements: {}, complaintHistory: [] };
        if (!progress.achievements) progress.achievements = {};

        let changed = false;

        // Проверка достижений за дни
        const installDate = new Date(created_at).getTime();
        const daysUsed = Math.floor((Date.now() - installDate) / DAY_IN_MS) + 1;
        const dayAchievements = { 'days_1': 1, 'days_7': 7, 'days_30': 30 };

        for (const [achId, requiredDays] of Object.entries(dayAchievements)) {
            if (daysUsed >= requiredDays && !progress.achievements[achId]) {
                progress.achievements[achId] = { grantedAt: Date.now() };
                changed = true;
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


// Запуск сервера
app.listen(port, async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                forum_id VARCHAR(20) UNIQUE NOT NULL,
                nickname VARCHAR(50) NOT NULL,
                admin_level INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ,
                last_seen TIMESTAMPTZ,
                progress JSONB,
                settings JSONB,
                last_sync TIMESTAMPTZ
            );
        `);
        console.log('Database table "users" schema check complete.');
        console.log(`Server is running on port ${port}`);

    } catch (err) {
        console.error('Database initialization error:', err);
    }
});