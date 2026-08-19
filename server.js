require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// ١. پشتڕاستکرن ژ کلیلا گووگڵ API
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('❌ شاشییا گرنگ: GEMINI_API_KEY د فایلا .env دا نینە!');
    process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

// ٢. خویندنا داتابەیسا کەلوپەلان ژ products.json
function getProducts() {
    try {
        const filePath = path.join(__dirname, 'products.json');
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error('❌ شاشی د خویندنا products.json دا:', e);
        return [];
    }
}

// ٣. پاشکەوتکرنا داواکاریێن نوی د orders.json دا
function saveOrder(orderData) {
    try {
        const filePath = path.join(__dirname, 'orders.json');
        let orders = [];
        if (fs.existsSync(filePath)) {
            orders = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        const newOrder = {
            id: "ORD-" + Math.floor(10000 + Math.random() * 90000),
            customer: orderData.customer || "نەدیار",
            phone: orderData.phone || "نەدیار",
            address: orderData.address || "نەدیار",
            item: orderData.item || "کەلوپەلێ گشتی",
            platform: orderData.platform || "گشتی",
            date: new Date().toLocaleString('en-US', { timeZone: 'Asia/Baghdad' }),
            status: "نوی"
        };
        orders.unshift(newOrder);
        fs.writeFileSync(filePath, JSON.stringify(orders, null, 2), 'utf8');
        console.log(`✅ داواکاریا نوی هاتە تۆمارکرن: ${newOrder.id}`);
        return newOrder.id;
    } catch (e) {
        console.error('❌ شاشی د پاشکەوتکرنا داواکاریێ دا:', e);
        return "ORD-0000";
    }
}

// ٤. مۆتۆڕێ ناڤەندی یێ زێڕینی بۆ دروستکرنا بەرسڤێن AI ب بادینی
async function generateAiReply(userMessage, platformName) {
    const products = getProducts();
    const systemPrompt = `
تۆ بریکارەکێ فرۆشتنێ یێ کارامە و زیرەکی ل دوکانا مە ل سەر پلاتفۆرمێ [${platformName}].
زمانێ تە: بەرسڤێن تە تەنها ب زمانێ کوردی - شێوەزارێ بادینی (دەڤۆکا دهۆک و زاخۆ) بن. گەلەک ب ڕێز، گەرم و جەذاب بەرسڤێ بدە.

داتابەیسا کەلوپەلێن ئامادە ل دوکانێ:
${JSON.stringify(products, null, 2)}

ڕێنما و یاسا:
١. تەنها ب کوردییا بادینی بەرسڤ بدە.
٢. دەمێ کڕیاری داواکاریا نرخ یان زانیاری کر، تەماشەی داتابەیسێ بکە و بەرسڤێ بدە.
٣. ئەگەر کڕیاری داخوازا وێنەی کر بۆ پارچەیەکێ، نیشانا [IMAGE: ناڤێ پارچەیێ] د ناو دەقێ بەرسڤا خۆ دا چێکە.
٤. دەمێ کڕیار بەرهەڤ بوو بۆ کڕینێ، زانیاریان وەربگرە (ناڤ، تەلەفۆن، ناڤنیشان، کەلوپەل) و ئەڤێ هێلێ د داوییا بەرسڤێ دا دیار بکە:
[ORDER_CONFIRMED: ناڤێ کڕیاری | ژمارا تەلەفۆنێ | ناڤنیشان | ناڤێ پارچەیێ]
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userMessage,
            config: {
                systemInstruction: systemPrompt
            }
        });
        return response.text || "";
    } catch (err) {
        console.error(`❌ شاشییا AI ل سەر پلاتفۆرمێ ${platformName}:`, err);
        return "ببورە، نوکە کێشەیەکا تەکنیکی یا هەی. ژکەرەما خۆ دووبارە بڕێزە.";
    }
}

// ==========================================
// پلاتفۆرمێ ١: واتسئەپ (WHATSAPP BOT)
// ==========================================

// دیتنەوەی ڕێڕەوی دروستی Chromium د سەر سێرڤەر دا
function findChromiumExecutable() {
    // ١. ئەگەر env variable هاتبیت دانان و ڕاست بیت، ئەوێ بکار بینە
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) {
        return envPath;
    }

    // ٢. جهێن ستاندارد یێن Debian/Ubuntu/Alpine بپشکنە (بۆ Dockerfile یێن apt/apk)
    const possiblePaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable'
    ];
    const found = possiblePaths.find(p => fs.existsSync(p));
    if (found) return found;

    // ٣. بۆ Railway/Nixpacks: Chromium د ژێر /nix/store/... دا یە ب hash یا گۆهۆرباری
    //    بۆیە پێدڤیە ب فەرمانا "which" یان گەرینا ناڤ Nix store بهێتە دیتن
    try {
        const whichResult = execSync('which chromium', { encoding: 'utf8' }).trim();
        if (whichResult && fs.existsSync(whichResult)) return whichResult;
    } catch (e) {
        // "which" نەبوویە سەرکەفتی، دۆم بکە بۆ ڕێکا دواتر
    }

    try {
        // گەرین ب ڕاستەوخۆ ناڤ /nix/store دا بۆ binary یا chromium
        const nixResult = execSync(
            "find /nix/store -maxdepth 4 -type f -name chromium -path '*/bin/*' 2>/dev/null | head -n 1",
            { encoding: 'utf8' }
        ).trim();
        if (nixResult && fs.existsSync(nixResult)) return nixResult;
    } catch (e) {
        // نەهاتە دیتن
    }

    console.error('❌ Chromium نەهاتە دیتن ل هیچ جهێ! تکایە پشتڕاست بە کو Chromium د nixpacks.toml/Dockerfile دا هاتیە دانان.');
    return undefined;
}

const chromiumPath = findChromiumExecutable();
console.log(`📌 Using Chromium executable at: ${chromiumPath || '(نەهاتە دیتن)'}`);

if (!chromiumPath) {
    console.error('❌ شاشییا گرنگ: Chromium نەهاتە دیتن. بۆتێ واتسئەپێ نەشێت دەست پێ بکەت.');
    process.exit(1);
}

const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: chromiumPath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

whatsappClient.on('qr', (qr) => {
    console.log('\n=== کۆدێ QR بۆ واتسئەپێ سکان بکە ===\n');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.log('🚀 [WhatsApp Engine]: بۆتێ واتسئەپێ ب تەمامی ئامادەیە!');
});

whatsappClient.on('message', async (msg) => {
    if (msg.from.includes('@g.us') || msg.from.includes('@newsletter') || msg.from.includes('@broadcast')) return;

    console.log(`📩 [WhatsApp DM]: ${msg.body}`);
    let botReply = await generateAiReply(msg.body, 'WhatsApp');

    // داواکاری
    if (botReply.includes('[ORDER_CONFIRMED:')) {
        const match = botReply.match(/\[ORDER_CONFIRMED:\s*(.*?)\]/);
        if (match && match[1]) {
            const parts = match[1].split('|').map(s => s.trim());
            const orderId = saveOrder({ customer: parts[0], phone: parts[1], address: parts[2], item: parts[3], platform: 'WhatsApp' });
            botReply = botReply.replace(/\[ORDER_CONFIRMED:.*?\]/, `\n\n📌 **داواکاریا تە هاتە تۆمارکرن ب ژمارە (${orderId})!**`);
        }
    }

    // وێنە
    if (botReply.includes('[IMAGE:')) {
        const imgMatch = botReply.match(/\[IMAGE:\s*(.*?)\]/);
        if (imgMatch && imgMatch[1]) {
            const productName = imgMatch[1].toLowerCase().trim();
            const matchedProduct = getProducts().find(p => p.name.toLowerCase().includes(productName));
            botReply = botReply.replace(/\[IMAGE:.*?\]/, '').trim();

            if (botReply.length > 0) await msg.reply(botReply);

            if (matchedProduct && matchedProduct.image) {
                try {
                    const media = await MessageMedia.fromUrl(matchedProduct.image);
                    await whatsappClient.sendMessage(msg.from, media, { caption: `وێنێ: ${matchedProduct.name} - نرخ: ${matchedProduct.price}` });
                } catch (e) {
                    console.error('❌ شاشی د فرێکرنا وێنێ واتسئەپێ دا:', e);
                }
            }
            return;
        }
    }

    if (botReply.trim().length > 0) {
        await msg.reply(botReply);
    }
});

whatsappClient.initialize();

// ==========================================
// پلاتفۆرمێ ٢: تێلیگرام (TELEGRAM BOT)
// ==========================================
if (process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('AAExxxxx')) {
    const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    console.log('🚀 [Telegram Engine]: بۆتێ تێلیگرامێ چالاک بوو!');

    telegramBot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        console.log(`📩 [Telegram DM]: ${msg.text}`);

        let botReply = await generateAiReply(msg.text, 'Telegram');

        if (botReply.includes('[ORDER_CONFIRMED:')) {
            const match = botReply.match(/\[ORDER_CONFIRMED:\s*(.*?)\]/);
            if (match && match[1]) {
                const parts = match[1].split('|').map(s => s.trim());
                const orderId = saveOrder({ customer: parts[0], phone: parts[1], address: parts[2], item: parts[3], platform: 'Telegram' });
                botReply = botReply.replace(/\[ORDER_CONFIRMED:.*?\]/, `\n\n📌 **داواکاریا تە هاتە تۆمارکرن ب ژمارە (${orderId})!**`);
            }
        }

        if (botReply.includes('[IMAGE:')) {
            const imgMatch = botReply.match(/\[IMAGE:\s*(.*?)\]/);
            if (imgMatch && imgMatch[1]) {
                const pName = imgMatch[1].toLowerCase().trim();
                const matchedProduct = getProducts().find(p => p.name.toLowerCase().includes(pName));
                botReply = botReply.replace(/\[IMAGE:.*?\]/, '').trim();

                if (botReply) await telegramBot.sendMessage(chatId, botReply);
                if (matchedProduct && matchedProduct.image) {
                    await telegramBot.sendPhoto(chatId, matchedProduct.image, { caption: `${matchedProduct.name} - ${matchedProduct.price}` });
                }
                return;
            }
        }

        await telegramBot.sendMessage(chatId, botReply);
    });
}

// ==========================================
// پلاتفۆرمێ ٣: ئێنستاگرام و مەسنجەر (META API)
// ==========================================
app.get('/webhook/meta', (req, res) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'kurdish_ai_token';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook/meta', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    const body = req.body;

    if (body.object === 'page' || body.object === 'instagram') {
        for (const entry of body.entry) {
            try {
                // بەرسڤدانا دایرێکتان (Direct Messages)
                const webhookEvent = entry.messaging ? entry.messaging[0] : null;
                if (webhookEvent && webhookEvent.message && webhookEvent.message.text) {
                    const senderPsid = webhookEvent.sender.id;
                    const userMessage = webhookEvent.message.text;
                    console.log(`📩 [Meta DM (${body.object})]: ${userMessage}`);

                    let aiReply = await generateAiReply(userMessage, body.object);

                    if (process.env.META_PAGE_ACCESS_TOKEN) {
                        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: aiReply }
                        });
                    }
                }

                // بەرسڤدانا کۆمێنتان (Comments)
                if (entry.changes) {
                    for (const change of entry.changes) {
                        if (change.field === 'comments' && change.value && change.value.text) {
                            const commentId = change.value.id;
                            const commentText = change.value.text;
                            console.log(`💬 [Meta Comment]: ${commentText}`);

                            let aiReply = await generateAiReply(commentText, 'Instagram/FB Comment');

                            if (process.env.META_PAGE_ACCESS_TOKEN) {
                                await axios.post(`https://graph.facebook.com/v19.0/${commentId}/replies?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`, {
                                    message: aiReply
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('❌ شاشی د پڕۆسەییا Meta Webhook دا:', err.message);
            }
        }
    }
});

// ==========================================
// پلاتفۆرمێ ٤: تیک تۆک (TIKTOK BUSINESS API)
// ==========================================
app.post('/webhook/tiktok', async (req, res) => {
    res.status(200).send('OK');
    const { event, data } = req.body || {};

    if (event === 'im.message.receive' && data && data.content) {
        try {
            const senderId = data.sender_open_id;
            const userMessage = data.content;
            console.log(`📩 [TikTok DM]: ${userMessage}`);

            let aiReply = await generateAiReply(userMessage, 'TikTok');

            if (process.env.TIKTOK_ACCESS_TOKEN) {
                await axios.post('https://open.tiktokapis.com/v2/im/message/send/', {
                    recipient_open_id: senderId,
                    message: { text: aiReply }
                }, {
                    headers: { 'Authorization': `Bearer ${process.env.TIKTOK_ACCESS_TOKEN}` }
                });
            }
        } catch (err) {
            console.error('❌ شاشی د پڕۆسەییا TikTok Webhook دا:', err.message);
        }
    }
});

// دەستپێکرنا سێرڤەرێ EXPRESS
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 سێرڤەرێ ناڤەندی یێ Kurdish AI ل سەر پۆرتێ ${PORT} چالاک بوو!`);
    console.log(`======================================================\n`);
});
