const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ============================================================
// ARQUIVOS DE PERSISTÊNCIA
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');
const GAMES_FILE = path.join(DATA_DIR, 'customGames.json');
const STATS_FILE = path.join(DATA_DIR, 'gameStats.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================================
// CARREGAR E SALVAR DADOS
// ============================================================

function loadGames() {
    if (fs.existsSync(GAMES_FILE)) {
        try {
            const data = fs.readFileSync(GAMES_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('❌ Erro ao carregar jogos:', err);
            return {};
        }
    }
    return {};
}

function loadStats() {
    if (fs.existsSync(STATS_FILE)) {
        try {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('❌ Erro ao carregar estatísticas:', err);
            return {};
        }
    }
    return {};
}

function saveGames(games) {
    try {
        fs.writeFileSync(GAMES_FILE, JSON.stringify(games, null, 2));
        console.log(`💾 ${Object.keys(games).length} jogos salvos`);
    } catch (err) {
        console.error('❌ Erro ao salvar jogos:', err);
    }
}

function saveStats(stats) {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        console.log(`💾 ${Object.keys(stats).length} estatísticas salvas`);
    } catch (err) {
        console.error('❌ Erro ao salvar estatísticas:', err);
    }
}

// ============================================================
// VARIÁVEIS DE ONLINE E CONTROLE DE VERSÃO
// ============================================================
const VERSAO_ATUAL = "2.0.0"; // 👈 Toda vez que atualizar o jogo, você muda isso aqui!

const onlineUsers = {};
let onlineCount = 0;
let customGames = loadGames();
let gameStats = loadStats();

// Não cria jogos de exemplo - começa vazio!
console.log(`📦 ${Object.keys(customGames).length} jogos carregados (apenas jogos da comunidade)`);
console.log(`📊 ${Object.keys(gameStats).length} estatísticas carregadas`);

// ============================================================
// FUNÇÕES DE TRANSMISSÃO (BROADCAST)
// ============================================================

function sendAllGames(socket) {
    socket.emit('allCustomGames', customGames);
    socket.emit('allGameStats', gameStats);
    socket.emit('onlineCount', onlineCount);
    socket.emit('onlineUsers', Object.values(onlineUsers).map(u => u.playerName));
    
    // 🛠️ ENVIANDO A VERSÃO DO SERVIDOR PARA O CLIENTE
    socket.emit('checkVersion', VERSAO_ATUAL); 
}

function broadcastToAll() {
    io.emit('allCustomGames', customGames);
    io.emit('allGameStats', gameStats);
    io.emit('onlineCount', onlineCount);
    io.emit('onlineUsers', Object.values(onlineUsers).map(u => u.playerName));
}

// ============================================================
// SERVIDOR SOCKET.IO
// ============================================================

io.on('connection', (socket) => {
    // Registrar automaticamente
    onlineCount++;
    const playerName = 'Jogador-' + socket.id.substring(0, 6);
    
    onlineUsers[socket.id] = {
        id: socket.id,
        name: playerName,
        playerName: playerName,
        connectedAt: new Date().toISOString()
    };
    
    console.log(`✅ Conectado: ${socket.id} - ${playerName}`);
    console.log(`👥 Total online: ${onlineCount}`);
    
    // Enviar TODOS os jogos e checar a versão do novo usuário
    sendAllGames(socket);
    console.log(`📦 Enviados ${Object.keys(customGames).length} jogos para ${socket.id}`);
    
    // Notificar todos sobre o novo usuário
    io.emit('player_joined', {
        playerName: playerName,
        playerId: socket.id,
        totalOnline: onlineCount,
        onlineUsers: Object.values(onlineUsers).map(u => u.playerName)
    });
    
    // Atualizar contagem para todos
    io.emit('updateOnlineCount', onlineCount);

    // ----- RECEBER NOME PERSONALIZADO -----
    socket.on('setName', (data) => {
        if (data && data.name) {
            const oldName = onlineUsers[socket.id].playerName;
            onlineUsers[socket.id].playerName = data.name;
            onlineUsers[socket.id].name = data.name;
            console.log(`✏️ ${oldName} mudou para: ${data.name}`);
            io.emit('player_name_changed', {
                id: socket.id,
                oldName: oldName,
                newName: data.name
            });
            broadcastToAll();
        }
    });

    // ----- PUBLICAR JOGO -----
    socket.on('publishCustomGame', (gameData) => {
        const user = onlineUsers[socket.id];
        const creatorName = user ? user.playerName : socket.id;
        
        console.log(`📤 Publicando: "${gameData.name}" por ${creatorName}`);
        
        const gameId = gameData.id || 'custom-' + Date.now();
        gameData.id = gameId;
        gameData.creator = creatorName;
        gameData.publishedAt = new Date().toISOString();
        
        // Salvar no servidor
        customGames[gameId] = gameData;
        if (!gameStats[gameId]) {
            gameStats[gameId] = { players: 0, likes: [], dislikes: [] };
        }
        
        // Salvar no disco
        saveGames(customGames);
        saveStats(gameStats);
        
        // Enviar para TODOS os online
        broadcastToAll();
        io.emit('newCustomGame', { gameId, game: gameData });
        
        console.log(`✅ Jogo "${gameData.name}" publicado para ${onlineCount} usuários`);
    });

    // ----- ATUALIZAR ESTATÍSTICAS -----
    socket.on('updateGameStats', (data) => {
        const { gameId, stats } = data;
        if (gameStats[gameId]) {
            gameStats[gameId] = { ...gameStats[gameId], ...stats };
            saveStats(gameStats);
            io.emit('gameStatsUpdated', { gameId, stats: gameStats[gameId] });
            // Atualizar para todos
            io.emit('allGameStats', gameStats);
        }
    });

    // ----- SOLICITAR JOGOS -----
    socket.on('requestAllGames', () => {
        sendAllGames(socket);
        console.log(`📦 Reenviados ${Object.keys(customGames).length} jogos para ${socket.id}`);
    });

    // ----- DELETAR JOGO -----
    socket.on('deleteCustomGame', (gameId) => {
        if (customGames[gameId]) {
            const gameName = customGames[gameId].name;
            const creator = customGames[gameId].creator;
            const user = onlineUsers[socket.id];
            
            if (user && user.playerName === creator) {
                delete customGames[gameId];
                delete gameStats[gameId];
                saveGames(customGames);
                saveStats(gameStats);
                broadcastToAll();
                io.emit('gameDeleted', gameId);
                console.log(`🗑️ Jogo "${gameName}" deletado por ${creator}`);
            } else {
                socket.emit('error', { message: 'Você não é o criador deste jogo' });
            }
        }
    });

    // ----- MOVIMENTO -----
    socket.on('playerMovement', (data) => {
        socket.broadcast.emit('playerMoved', { id: socket.id, pos: data });
    });

    // ----- CHAT -----
    socket.on('playerChat', (data) => {
        const user = onlineUsers[socket.id];
        const playerName = user ? user.playerName : socket.id;
        io.emit('chat_message', {
            id: socket.id,
            playerName: playerName,
            message: data.message
        });
    });

    // ----- DESCONEXÃO -----
    socket.on('disconnect', () => {
        onlineCount--;
        const user = onlineUsers[socket.id];
        if (user) {
            console.log(`❌ Saiu: ${user.playerName}`);
            delete onlineUsers[socket.id];
        }
        console.log(`👥 Total online: ${onlineCount}`);
        
        io.emit('player_left', {
            playerName: user ? user.playerName : socket.id,
            playerId: socket.id,
            totalOnline: onlineCount,
            onlineUsers: Object.values(onlineUsers).map(u => u.playerName)
        });
        io.emit('updateOnlineCount', onlineCount);
        io.emit('playerDisconnected', socket.id);
        broadcastToAll();
    });
});

// ============================================================
// AUTO-REFRESH A CADA 30 SEGUNDOS
// ============================================================

setInterval(() => {
    const newGames = loadGames();
    const newStats = loadStats();
    
    if (JSON.stringify(newGames) !== JSON.stringify(customGames)) {
        console.log('🔄 Recarregando jogos do disco...');
        customGames = newGames;
        gameStats = newStats;
        broadcastToAll();
    }
}, 30000);

// ============================================================
// ROTAS HTTP - PARA VER OS DADOS
// ============================================================

app.get('/online', (req, res) => {
    res.json({
        total: onlineCount,
        users: Object.values(onlineUsers).map(u => u.playerName)
    });
});

app.get('/games', (req, res) => {
    res.json(customGames);
});

app.get('/stats', (req, res) => {
    res.json({
        totalGames: Object.keys(customGames).length,
        online: onlineCount,
        users: Object.values(onlineUsers).map(u => u.playerName),
        games: customGames
    });
});

app.get('/games/:id', (req, res) => {
    const game = customGames[req.params.id];
    if (game) {
        res.json(game);
    } else {
        res.status(404).json({ error: 'Jogo não encontrado' });
    }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

http.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📦 ${Object.keys(customGames).length} jogos carregados (apenas da comunidade)`);
    console.log(`👥 ${onlineCount} jogadores online`);
    console.log(`📁 Dados salvos em: ${DATA_DIR}`);
    console.log(`🔄 Auto-refresh a cada 30 segundos`);
    console.log(`📝 Registro automático de jogadores ativado`);
});