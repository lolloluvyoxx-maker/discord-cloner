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
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const MONGODB_URI = process.env.MONGODB_URI;

// Opzioni
const RENAME_VIDEOS = true;
const VIDEO_NAME = 'SENSATIONAL';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'];
const MAX_MESSAGES = null;           // null = tutti i messaggi
const SLEEP_MS = 1200;               // pausa tra operazioni (ms)
const MAX_RETRIES = 3;                // tentativi di download/upload
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
      lastProcessedMessageId: String
    }, { _id: false })
  },
  videoCounter: Number
});
const State = mongoose.model('State', stateSchema);
// --------------------------------------------------------

async function saveState(guildId, categoryId, channelsMap, videoCounter) {
  try {
    await State.findOneAndUpdate(
      { guildId, categoryId },
      { channels: channelsMap, videoCounter },
      { upsert: true }
    );
    console.log('💾 Stato salvato su MongoDB');
  } catch (err) {
    console.error('❌ Errore salvataggio stato:', err.message);
  }
}

async function loadState(guildId, categoryId) {
  try {
    return await State.findOne({ guildId, categoryId });
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
      console.log(`⏳ Tentativo ${i+1} fallito per ${url}, riprovo...`);
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
      console.log(`⏳ Invio fallito (tentativo ${i+1}), riprovo...`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function cloneMedia(sourceGuild, targetChannel, state) {
  console.log(`🔍 Cerco categoria ${SOURCE_CATEGORY_ID}`);
  const category = sourceGuild.channels.cache.get(SOURCE_CATEGORY_ID);
  if (!category || category.type !== 'GUILD_CATEGORY') {
    console.error('❌ Categoria non trovata o non valida');
    return;
  }

  const textChannels = category.children.cache.filter(c => c.type === 'GUILD_TEXT');
  console.log(`📂 Trovati ${textChannels.size} canali testuali nella categoria.`);

  let totalFiles = 0;
  let videoCounter = state?.videoCounter || 1;
  let channelsState = state?.channels ? new Map(Object.entries(state.channels)) : new Map();

  for (const channel of textChannels.values()) {
    const channelId = channel.id;
    let channelData = channelsState.get(channelId) || { completed: false };

    if (channelData.completed) {
      console.log(`⏭️ Canale #${channel.name} già completato, salto.`);
      continue;
    }

    console.log(`\n📨 Elaborazione canale #${channel.name} (${channelId})`);

    try {
      let options = { limit: 100 };
      if (channelData.lastProcessedMessageId) {
        options.after = channelData.lastProcessedMessageId;
        console.log(`🔄 Riprendo dal messaggio successivo a ${channelData.lastProcessedMessageId}`);
      }

      let fetchedMessages = 0;
      let done = false;

      while (!done) {
        const messages = await channel.messages.fetch(options).catch(err => {
          console.error(`Errore fetch messaggi: ${err.message}`);
          return null;
        });
        if (!messages || messages.size === 0) break;

        for (const message of messages.values()) {
          if (!message.attachments.size) continue;

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

          channelData.lastProcessedMessageId = message.id;
          channelsState.set(channelId, channelData);
          await saveState(sourceGuild.id, category.id, Object.fromEntries(channelsState), videoCounter);
        }

        fetchedMessages += messages.size;
        if (MAX_MESSAGES && fetchedMessages >= MAX_MESSAGES) {
          console.log(`⚠️ Raggiunto limite di ${MAX_MESSAGES} messaggi per questo canale.`);
          done = true;
          break;
        }

        if (messages.size < 100) {
          done = true;
        } else {
          options.before = messages.last().id;
          await new Promise(r => setTimeout(r, SLEEP_MS));
        }
      }

      channelData.completed = true;
      channelsState.set(channelId, channelData);
      await saveState(sourceGuild.id, category.id, Object.fromEntries(channelsState), videoCounter);
      console.log(`✅ Canale #${channel.name} completato.`);

    } catch (err) {
      console.error(`❌ Errore grave nel canale #${channel.name}:`, err.message);
      await saveState(sourceGuild.id, category.id, Object.fromEntries(channelsState), videoCounter);
    }
  }

  console.log(`\n✅ Clonazione completata! Totale file trasferiti: ${totalFiles}`);
}

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Self‑bot con checkpoint MongoDB'));
app.listen(PORT, () => console.log(`🌐 Server HTTP su porta ${PORT}`));

client.on('ready', async () => {
  if (isRunning) return;
  isRunning = true;

  console.log(`✅ Self‑bot connesso come ${client.user.tag}`);

  let connected = false;
  for (let i = 0; i < 5; i++) {
    try {
      await mongoose.connect(MONGODB_URI);
      connected = true;
      console.log('📦 Connesso a MongoDB');
      break;
    } catch (err) {
      console.log(`⏳ Connessione MongoDB fallita (tentativo ${i+1}/5):`, err.message);
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
    return;
  }

  const targetChannel = targetGuild.channels.cache.get(TARGET_CHANNEL_ID);
  if (!targetChannel || targetChannel.type !== 'GUILD_TEXT') {
    console.error('❌ Canale destinazione non valido.');
    return;
  }

  const state = await loadState(sourceGuild.id, SOURCE_CATEGORY_ID);
  if (state) {
    console.log('🔄 Stato precedente caricato, riprendo da dove ero rimasto.');
  } else {
    console.log('🆕 Nessuno stato precedente, parto dall\'inizio.');
  }

  await cloneMedia(sourceGuild, targetChannel, state);
  console.log('🏁 Operazione terminata. Il self‑bot rimane in esecuzione.');
});

client.login(USER_TOKEN).catch(err => {
  console.error('❌ Errore di login:', err.message);
  process.exit(1);
});
