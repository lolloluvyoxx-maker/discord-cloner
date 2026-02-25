const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

// ==================== CONFIGURAZIONE ====================
const USER_TOKEN = process.env.USER_TOKEN;
const SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const SOURCE_CATEGORY_ID = process.env.SOURCE_CATEGORY_ID;
const MONGODB_URI = process.env.MONGODB_URI;

// Opzioni
const RENAME_VIDEOS = true;
const VIDEO_NAME = 'SENSATIONAL';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'];
const MAX_MESSAGES = null;           // null = tutti i messaggi
const SLEEP_MS = 1200;               // pausa tra operazioni (ms)
const MAX_RETRIES = 3;               // tentativi di download/upload
// =========================================================

const client = new Client();
let isRunning = false;

// ------------------ MODELLO MONGOOSE ------------------
const stateSchema = new mongoose.Schema({
  guildId: String,
  categoryId: String,
  channels: {
    type: Map,
    of: new mongoose.Schema({
      completed: Boolean,
      lastProcessedMessageId: String,
      targetChannelId: String
    }, { _id: false })
  },
  videoCounter: Number
});
const State = mongoose.model('State', stateSchema);
// --------------------------------------------------------

async function saveState(guildId, categoryId, channelsMap, videoCounter) {
  try {
    const plainChannels = {};
    for (const [key, value] of channelsMap.entries()) {
      plainChannels[key] = value;
    }
    await State.findOneAndUpdate(
      { guildId, categoryId },
      { channels: plainChannels, videoCounter },
      { upsert: true, new: true }
    );
    console.log('💾 Stato salvato su MongoDB');
  } catch (err) {
    console.error('❌ Errore salvataggio stato:', err.message);
  }
}

async function loadState(guildId, categoryId) {
  try {
    const doc = await State.findOne({ guildId, categoryId });
    if (doc) {
      const channelsMap = new Map(Object.entries(doc.channels || {}));
      return { channels: channelsMap, videoCounter: doc.videoCounter };
    }
    return null;
  } catch (err) {
    console.error('❌ Errore caricamento stato:', err.message);
    return null;
  }
}

async function downloadFile(url, outputPath, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const writer = fs.createWriteStream(outputPath);
      const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      return true;
    } catch (err) {
      console.log(`⏳ Tentativo ${i + 1} fallito per ${url}, riprovo...`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function sendFileWithRetry(channel, filePath, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      await channel.send({ files: [filePath] });
      return true;
    } catch (err) {
      console.log(`⏳ Invio fallito (tentativo ${i + 1}), riprovo...`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function getOrCreateTargetChannel(targetGuild, sourceChannelName, sourceChannelId, channelsState) {
  const existing = channelsState.get(sourceChannelId);

  if (existing && existing.targetChannelId) {
    const cachedChannel = targetGuild.channels.cache.get(existing.targetChannelId);
    if (cachedChannel) return cachedChannel;
  }

  let targetChannel = targetGuild.channels.cache.find(
    c => c.name === sourceChannelName && c.type === 'GUILD_TEXT'
  );

  if (!targetChannel) {
    console.log(`➕ Creazione canale #${sourceChannelName} nel server target...`);
    targetChannel = await targetGuild.channels.create(sourceChannelName, {
      type: 'GUILD_TEXT',
      reason: 'Creato per clonazione media'
    });
    await new Promise(r => setTimeout(r, 2000));
  } else {
    console.log(`🔁 Canale #${sourceChannelName} già esistente, verrà utilizzato.`);
  }

  return targetChannel;
}

async function cloneMedia(sourceGuild, targetGuild, state) {
  console.log(`🔍 Cerco categoria ${SOURCE_CATEGORY_ID}`);

  // FIX: fetch esplicito di tutti i canali per popolare la cache
  await sourceGuild.channels.fetch();
  await targetGuild.channels.fetch();

  const category = sourceGuild.channels.cache.get(SOURCE_CATEGORY_ID);
  if (!category || category.type !== 'GUILD_CATEGORY') {
    console.error('❌ Categoria non trovata o non valida');
    return;
  }

  const textChannels = sourceGuild.channels.cache.filter(
    c => c.parentId === SOURCE_CATEGORY_ID && c.type === 'GUILD_TEXT'
  );
  console.log(`📂 Trovati ${textChannels.size} canali testuali nella categoria.`);

  let totalFiles = 0;
  let videoCounter = state?.videoCounter || 1;
  let channelsState = state?.channels || new Map();

  for (const sourceChannel of textChannels.values()) {
    const sourceChannelId = sourceChannel.id;
    let channelData = channelsState.get(sourceChannelId) || { completed: false };

    if (channelData.completed) {
      console.log(`⏭️ Canale #${sourceChannel.name} già completato, salto.`);
      continue;
    }

    console.log(`\n📨 Elaborazione canale #${sourceChannel.name} (${sourceChannelId})`);

    const targetChannel = await getOrCreateTargetChannel(
      targetGuild, sourceChannel.name, sourceChannelId, channelsState
    );

    channelData.targetChannelId = targetChannel.id;
    channelsState.set(sourceChannelId, channelData);
    await saveState(sourceGuild.id, category.id, channelsState, videoCounter);

    try {
      let fetchedMessages = 0;
      let done = false;
      let afterId = channelData.lastProcessedMessageId || '0';

      if (channelData.lastProcessedMessageId) {
        console.log(`🔄 Riprendo dal messaggio successivo a ${channelData.lastProcessedMessageId}`);
      }

      while (!done) {
        const options = { limit: 100, after: afterId };

        const messages = await sourceChannel.messages.fetch(options).catch(err => {
          console.error(`Errore fetch messaggi: ${err.message}`);
          return null;
        });

        if (!messages || messages.size === 0) break;

        const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const message of sortedMessages) {
          if (message.attachments.size) {
            for (const attachment of message.attachments.values()) {
              const ext = path.extname(attachment.name).toLowerCase();
              const isImage = IMAGE_EXTS.includes(ext);
              const isVideo = VIDEO_EXTS.includes(ext);
              if (!isImage && !isVideo) continue;

              let newFileName;
              if (isVideo && RENAME_VIDEOS) {
                newFileName = `${VIDEO_NAME}_${videoCounter}${ext}`;
                videoCounter++;
              } else {
                newFileName = attachment.name;
              }

              console.log(`⬇️ Scaricamento: ${attachment.name} -> ${newFileName}`);
              const tempPath = path.join(__dirname, newFileName);

              try {
                await downloadFile(attachment.url, tempPath);
                console.log(`⬆️ Invio a #${targetChannel.name}`);
                await sendFileWithRetry(targetChannel, tempPath);
                fs.unlinkSync(tempPath);
                totalFiles++;
              } catch (err) {
                console.error(`❌ Fallimento definitivo per ${attachment.name}:`, err.message);
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
              }

              await new Promise(r => setTimeout(r, SLEEP_MS));
            }
          }

          channelData.lastProcessedMessageId = message.id;
          afterId = message.id;
          channelsState.set(sourceChannelId, channelData);
        }

        await saveState(sourceGuild.id, category.id, channelsState, videoCounter);

        fetchedMessages += messages.size;
        if (MAX_MESSAGES && fetchedMessages >= MAX_MESSAGES) {
          console.log(`⚠️ Raggiunto limite di ${MAX_MESSAGES} messaggi per questo canale.`);
          done = true;
          break;
        }

        if (messages.size < 100) {
          done = true;
        } else {
          await new Promise(r => setTimeout(r, SLEEP_MS));
        }
      }

      channelData.completed = true;
      channelsState.set(sourceChannelId, channelData);
      await saveState(sourceGuild.id, category.id, channelsState, videoCounter);
      console.log(`✅ Canale #${sourceChannel.name} completato.`);

    } catch (err) {
      console.error(`❌ Errore grave nel canale #${sourceChannel.name}:`, err.message);
      await saveState(sourceGuild.id, category.id, channelsState, videoCounter);
    }
  }

  console.log(`\n✅ Clonazione completata! Totale file trasferiti: ${totalFiles}`);
}

// ---------- Server HTTP per Render (obbligatorio per mantenere il servizio attivo) ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Self-bot attivo'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 Server HTTP in ascolto sulla porta ${PORT}`));
// --------------------------------------------------------------------------------------------

client.on('ready', async () => {
  if (isRunning) return;
  isRunning = true;

  console.log(`✅ Self-bot connesso come ${client.user.tag}`);

  // Verifica variabili d'ambiente obbligatorie
  const required = { USER_TOKEN, SOURCE_GUILD_ID, TARGET_GUILD_ID, SOURCE_CATEGORY_ID, MONGODB_URI };
  for (const [key, val] of Object.entries(required)) {
    if (!val) {
      console.error(`❌ Variabile d'ambiente mancante: ${key}`);
      process.exit(1);
    }
  }

  let connected = false;
  for (let i = 0; i < 5; i++) {
    try {
      await mongoose.connect(MONGODB_URI);
      connected = true;
      console.log('📦 Connesso a MongoDB');
      break;
    } catch (err) {
      console.log(`⏳ Connessione MongoDB fallita (tentativo ${i + 1}/5):`, err.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  if (!connected) {
    console.error('❌ Impossibile connettersi a MongoDB, esco.');
    process.exit(1);
  }

  const sourceGuild = client.guilds.cache.get(SOURCE_GUILD_ID);
  const targetGuild = client.guilds.cache.get(TARGET_GUILD_ID);
  if (!sourceGuild || !targetGuild) {
    console.error('❌ Server non trovati. Controlla SOURCE_GUILD_ID e TARGET_GUILD_ID');
    process.exit(1);
  }

  const state = await loadState(sourceGuild.id, SOURCE_CATEGORY_ID);
  if (state) {
    console.log('🔄 Stato precedente caricato, riprendo da dove ero rimasto.');
  } else {
    console.log("🆕 Nessuno stato precedente, parto dall'inizio.");
  }

  await cloneMedia(sourceGuild, targetGuild, state);

  await mongoose.disconnect();
  console.log('🏁 Operazione terminata. Il server HTTP rimane attivo.');
});

// Gestione errori non catturati per evitare crash del container Render
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
});

client.login(USER_TOKEN).catch(err => {
  console.error('❌ Errore di login:', err.message);
  process.exit(1);
});
      
