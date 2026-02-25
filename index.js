const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==================== CONFIGURAZIONE ====================
const USER_TOKEN = process.env.USER_TOKEN;
const SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const SOURCE_CATEGORY_ID = process.env.SOURCE_CATEGORY_ID;

const RENAME_VIDEOS = true;
const VIDEO_NAME = 'SENSATIONAL';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'];
const MAX_FILE_SIZE_MB = 25;
const SLEEP_MS = 800;
const MAX_RETRIES = 3;
const FILES_PER_MESSAGE = 2; // invia N file per messaggio webhook
// =========================================================

const client = new Client();
let isRunning = false;

// Contatore video globale con mutex per evitare duplicati tra canali paralleli
let videoCounter = 1;
function getNextVideoCounter() {
  return videoCounter++;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function downloadFile(url, outputPath, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const writer = fs.createWriteStream(outputPath);
      const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 60000 });
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      const stats = fs.statSync(outputPath);
      if (stats.size < 1024) {
        fs.unlinkSync(outputPath);
        throw new Error('URL scaduto o file corrotto');
      }
      return stats.size;
    } catch (err) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (i === retries - 1) throw err;
      await sleep(3000);
    }
  }
}

// Invia fino a FILES_PER_MESSAGE file in un solo messaggio webhook
async function sendPairViaWebhook(webhookUrl, filePaths, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const form = new FormData();
      filePaths.forEach((fp, idx) => {
        form.append(`files[${idx}]`, fs.createReadStream(fp));
      });
      await axios.post(webhookUrl, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000
      });
      return true;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(3000);
    }
  }
}

async function getOrCreateWebhook(targetChannel) {
  const webhooks = await targetChannel.fetchWebhooks();
  let webhook = webhooks.find(w => w.name === 'MediaCloner');
  if (!webhook) {
    webhook = await targetChannel.createWebhook('MediaCloner', { reason: 'Clonazione media' });
    await sleep(500);
  }
  return webhook.url;
}

async function getOrCreateTargetChannel(targetGuild, name) {
  let ch = targetGuild.channels.cache.find(c => c.name === name && c.type === 'GUILD_TEXT');
  if (!ch) {
    ch = await targetGuild.channels.create(name, { type: 'GUILD_TEXT' });
    await sleep(1500);
  }
  return ch;
}

// Processa un singolo canale: scarica e invia a coppie
async function processChannel(sourceChannel, targetGuild) {
  console.log(`\n📨 [#${sourceChannel.name}] Avvio elaborazione...`);

  const targetChannel = await getOrCreateTargetChannel(targetGuild, sourceChannel.name);
  const webhookUrl = await getOrCreateWebhook(targetChannel);

  let afterId = '0';
  let done = false;
  let buffer = []; // buffer di file scaricati pronti per l'invio
  let channelFiles = 0;

  while (!done) {
    const messages = await sourceChannel.messages.fetch({ limit: 100, after: afterId }).catch(() => null);
    if (!messages || messages.size === 0) break;

    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of sorted) {
      if (message.attachments.size) {
        let freshMessage = message;
        try { freshMessage = await sourceChannel.messages.fetch(message.id); } catch (_) {}

        for (const attachment of freshMessage.attachments.values()) {
          const ext = path.extname(attachment.name).toLowerCase();
          const isImage = IMAGE_EXTS.includes(ext);
          const isVideo = VIDEO_EXTS.includes(ext);
          if (!isImage && !isVideo) continue;

          if (attachment.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            console.log(`[#${sourceChannel.name}] ⚠️ Salto ${attachment.name} (${(attachment.size / 1024 / 1024).toFixed(1)}MB)`);
            continue;
          }

          let newFileName;
          if (isVideo && RENAME_VIDEOS) {
            const n = getNextVideoCounter();
            newFileName = `${VIDEO_NAME}_${n}${ext}`;
          } else {
            newFileName = attachment.name;
          }

          // Aggiungi prefisso canale al nome per evitare collisioni tra canali paralleli
          const tempPath = path.join(__dirname, `${sourceChannel.id}_${newFileName}`);
          console.log(`[#${sourceChannel.name}] ⬇️ ${attachment.name} -> ${newFileName}`);

          try {
            await downloadFile(attachment.url, tempPath);
            buffer.push({ tempPath, newFileName });

            // Quando il buffer è pieno, invia la coppia
            if (buffer.length >= FILES_PER_MESSAGE) {
              const pair = buffer.splice(0, FILES_PER_MESSAGE);
              const paths = pair.map(f => f.tempPath);
              const names = pair.map(f => f.newFileName).join(', ');
              console.log(`[#${sourceChannel.name}] ⬆️ Invio coppia: ${names}`);
              try {
                await sendPairViaWebhook(webhookUrl, paths);
                channelFiles += pair.length;
                console.log(`[#${sourceChannel.name}] ✅ Inviati: ${names}`);
              } catch (err) {
                console.error(`[#${sourceChannel.name}] ❌ Invio coppia fallito: ${err.message}`);
              }
              paths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
              await sleep(SLEEP_MS);
            }
          } catch (err) {
            console.error(`[#${sourceChannel.name}] ❌ Download fallito: ${attachment.name}: ${err.message}`);
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          }
        }
      }
      afterId = message.id;
    }

    if (messages.size < 100) done = true;
    else await sleep(SLEEP_MS);
  }

  // Invia eventuali file rimasti nel buffer (dispari)
  if (buffer.length > 0) {
    const paths = buffer.map(f => f.tempPath);
    const names = buffer.map(f => f.newFileName).join(', ');
    console.log(`[#${sourceChannel.name}] ⬆️ Invio rimanenti: ${names}`);
    try {
      await sendPairViaWebhook(webhookUrl, paths);
      channelFiles += buffer.length;
      console.log(`[#${sourceChannel.name}] ✅ Inviati: ${names}`);
    } catch (err) {
      console.error(`[#${sourceChannel.name}] ❌ Invio rimanenti fallito: ${err.message}`);
    }
    paths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
  }

  console.log(`[#${sourceChannel.name}] ✅ Completato! File inviati: ${channelFiles}`);
  return channelFiles;
}

async function cloneMedia(sourceGuild, targetGuild) {
  await sourceGuild.channels.fetch();
  await targetGuild.channels.fetch();

  const category = sourceGuild.channels.cache.get(SOURCE_CATEGORY_ID);
  if (!category || category.type !== 'GUILD_CATEGORY') {
    console.error('❌ Categoria non trovata');
    return;
  }

  const textChannels = sourceGuild.channels.cache.filter(
    c => c.parentId === SOURCE_CATEGORY_ID && c.type === 'GUILD_TEXT'
  );
  console.log(`📂 Trovati ${textChannels.size} canali — avvio in parallelo!`);

  // Lancia tutti i canali in parallelo
  const results = await Promise.allSettled(
    [...textChannels.values()].map(ch => processChannel(ch, targetGuild))
  );

  const totalFiles = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
  console.log(`\n🏁 Fine! Totale file inviati: ${totalFiles}`);
}

// ---------- Server HTTP per Render ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Self-bot attivo'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 Server HTTP in ascolto sulla porta ${PORT}`));
// --------------------------------------------

client.on('ready', async () => {
  if (isRunning) return;
  isRunning = true;

  console.log(`✅ Self-bot connesso come ${client.user.tag}`);

  const sourceGuild = client.guilds.cache.get(SOURCE_GUILD_ID);
  const targetGuild = client.guilds.cache.get(TARGET_GUILD_ID);
  if (!sourceGuild || !targetGuild) {
    console.error('❌ Server non trovati.');
    process.exit(1);
  }

  await cloneMedia(sourceGuild, targetGuild);
  console.log('🏁 Operazione terminata.');
});

process.on('unhandledRejection', reason => console.error('❌ Unhandled:', reason));
process.on('uncaughtException', err => console.error('❌ Exception:', err.message));

client.login(USER_TOKEN).catch(err => {
  console.error('❌ Login fallito:', err.message);
  process.exit(1);
});
          
