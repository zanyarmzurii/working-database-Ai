require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static('public')); // بۆ کارپێکرنا دێشبۆڕدا HTML د ناو فولدەرا public دا

// ١. پشتڕاستکرن ژ کلیلا گووگڵ API و دروستکرنا Client
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('❌ شاشییا گرنگ: GEMINI_API_KEY د فایلا .env دا نینە!');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

// بیردانکا ئاخفتنان (Chat History Memory)
const chatMemory = new Map();

function getChatHistory(userId) {
    if (!chatMemory.has(userId)) {
        chatMemory.set(userId, []);
    }
    return chatMemory.get(userId);
}

function updateChatHistory(userId, userMsg, aiMsg) {
    const history = getChatHistory(userId);
    history.push({ role: "user", parts: [{ text: userMsg }] });
    history.push({ role: "model", parts: [{ text: aiMsg }] });
    // پاراستنا ٥ ئاخفتنێن داویێ (١٠ نامە د ناو زنجیرێ دا)
    if (history.length > 10) {
        chatMemory.set(userId, history.slice(-10));
    }
}

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
function getOrders() {
    try {
        const filePath = path.join(__dirname, 'orders.json');
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveOrder(orderData) {
    try {
        const filePath = path.join(__dirname, 'orders.json');
        let orders = getOrders();
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

        // ئاگاهدارکرنا ڕاستەوخۆ یا ئادمینی ل سەر تێلیگرامێ
        sendAdminTelegramAlert(newOrder);

        return newOrder.id;
    } catch (e) {
        console.error('❌ شاشی د پاشکەوتکرنا داواکاریێ دا:', e);
        return "ORD-0000";
    }
}

// ٤. مۆتۆڕێ ناڤەندی یێ AI ب بیردانک و پشتگیرییا داشکانانڤە
async function generateAiReply(userId, userMessage, platformName) {
    const products = getProducts();
    const systemPrompt = `
تۆ بریکارەکێ فرۆشتنێ یێ کارامە و زیرەکی ل دوکانا مە ل سەر پلاتفۆرمێ [${platformName}].
زمانێ تە: بەرسڤێن تە تەنها ب زمانێ کوردی - شێوەزارێ بادینی (دەڤۆکا دهۆک و زاخۆ) بن. گەلەک ب ڕێز، گەرم و جەذاب بەرسڤێ بدە.

داتابەیسا کەلوپەلێن ئامادە و داشکانان (Discounts):
${JSON.stringify(products, null, 2)}

ڕێنما و یاسا:
١. تەنها ب کوردییا بادینی بەرسڤ بدە.
٢. دەمێ کڕیاری داواکاریا نرخ یان زانیاری کر، تەماشەی داتابەیسێ بکە. ئەگەر کەلوپەلێ داواکری داشکان (discount) یان ئۆفەر هەبوو، ب گەرمی کڕیار ئاگادار بکھ.
٣. ئەگەر کڕیاری داخوازا وێنەی کر بۆ پارچەیەکێ، نیشانا [IMAGE: ناڤێ پارچەیێ] د ناو دەقێ بەرسڤا خۆ دا چێکە.
٤. دەمێ کڕیار بەرهەڤ بوو بۆ کڕینێ، زانیاریان وەربگرە (ناڤ، تەلەفۆن، ناڤنیشان، کەلوپەل) و ئەڤێ هێلێ د داوییا بەرسڤێ دا دیار بکە:
[ORDER_CONFIRMED: ناڤێ کڕیاری | ژمارا تەلەفۆنێ | ناڤنیشان | ناڤێ پارچەیێ]
    `;

    try {
        const history = getChatHistory(userId);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: systemPrompt 
        });

        const chat = model.startChat({ history });
        const result = await chat.sendMessage(userMessage);
        const replyText = result.response.text() || "";

        // پاشکەوتکرنا ئاخفتنێ د بیردانکێ دا
        updateChatHistory(userId, userMessage, replyText);

        return replyText;
    } catch (err) {
        console.error(`❌ شاشییا AI ل سەر پلاتفۆرمێ ${platformName}:`, err.message);
        return "ببورە، نوکە کێشەیەکا تەکنیکی یا هەی. ژکەرەما خۆ دووبارە بڕێزە.";
    }
}

// ==========================================
// ٥. سیستمێ ئاگاهدارکرنا ئادمینی (ADMIN TELEGRAM ALERT)
// ==========================================
let globalTelegramBot = null;
if (process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('AAExxxxx')) {
    globalTelegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
}

function sendAdminTelegramAlert(order) {
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (globalTelegramBot && adminChatId) {
        const alertMsg = `🚨 **داواکارییا نوی هاتە تۆمارکرن!**\n\n🆔 **کۆد:** ${order.id}\n👤 **کڕیار:** ${order.customer}\n📞 **تەلەفۆن:** ${order.phone}\n📍 **ناڤنیشان:** ${order.address}\n📦 **کەلوپەل:** ${order.item}\n🌐 **پلاتفۆڕم:** ${order.platform}\n⏰ **مێژوو:** ${order.date}`;
        globalTelegramBot.sendMessage(adminChatId, alertMsg, { parse_mode: 'Markdown' }).catch(e => console.error("Error sending admin alert:", e.message));
    }
}

// ==========================================
// ٦. API دێشبۆڕدا وێب (WEB DASHBOARD ENDPOINTS)
// ==========================================
app.get('/api/orders', (req, res) => {
    res.json(getOrders());
});

app.post('/api/orders/update-status', (req, res) => {
    const { orderId, newStatus } = req.body;
    let orders = getOrders();
    const orderIndex = orders.findIndex(o => o.id === orderId);
    if (orderIndex !== -1) {
        orders[orderIndex].status = newStatus;
        fs.writeFileSync(path.join(__dirname, 'orders.json'), JSON.stringify(orders, null, 2), 'utf8');
        return res.json({ success: true, message: "ستاتۆس بە سەرکەوتوویی هاتە گۆڕین" });
    }
    res.status(404).json({ success: false, message: "داواکاری نەهاتە دیتن" });
});

// ==========================================
// پلاتفۆرمێ ١: واتسئەپ (WHATSAPP BOT)
// ==========================================
function findChromiumExecutable() {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    const possiblePaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'];
    const found = possiblePaths.find(p => fs.existsSync(p));
    if (found) return found;

    try {
        const whichResult = execSync('which chromium', { encoding: 'utf8' }).trim();
        if (whichResult && fs.existsSync(whichResult)) return whichResult;
    } catch (e) {}

    try {
        const nixResult = execSync("find /nix/store -maxdepth 4 -type f -name chromium -path '*/bin/*' 2>/dev/null | head -n 1", { encoding: 'utf8' }).trim();
        if (nixResult && fs.existsSync(nixResult)) return nixResult;
    } catch (e) {}

    return undefined;
}

// فەنکشنا پاککرنا لۆک فایلێن Chromium (Singleton Lock Cleaner)
function clearChromeLockRecursively(directory) {
    if (!fs.existsSync(directory)) return;
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    
    try {
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            if (fs.statSync(fullPath).isDirectory()) {
                clearChromeLockRecursively(fullPath);
            } else if (lockFiles.includes(file)) {
                try {
                    fs.unlinkSync(fullPath);
                    console.log(`🧹 [Chromium Lock Cleaner]: Removed stale lock file: ${fullPath}`);
                } catch (e) {
                    console.error(`⚠️ Could not remove lock file ${fullPath}:`, e.message);
                }
            }
        }
    } catch (err) {
        console.error(`⚠️ Error scanning directory for locks: ${directory}`, err.message);
    }
}

const chromiumPath = findChromiumExecutable();
console.log(`📌 Using Chromium executable at: ${chromiumPath || '(نەهاتە دیتن)'}`);

if (!chromiumPath) {
    console.error('❌ شاشییا گرنگ: Chromium نەهاتە دیتن. بۆتێ واتسئەپێ نەشێت دەست پێ بکەت.');
    process.exit(1);
}

// سڕینەڤەیا لۆک فایلان ژ فۆڵدەرا session بەریا دەستپێکرنا واتسئەپێ
const wwebjsAuthPath = path.join(__dirname, '.wwebjs_auth');
clearChromeLockRecursively(wwebjsAuthPath);

const whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
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
    let botReply = await generateAiReply(msg.from, msg.body, 'WhatsApp');

    if (botReply.includes('[ORDER_CONFIRMED:')) {
        const match = botReply.match(/\[ORDER_CONFIRMED:\s*(.*?)\]/);
        if (match && match[1]) {
            const parts = match[1].split('|').map(s => s.trim());
            const orderId = saveOrder({ customer: parts[0], phone: parts[1], address: parts[2], item: parts[3], platform: 'WhatsApp' });
            botReply = botReply.replace(/\[ORDER_CONFIRMED:.*?\]/, `\n\n📌 **داواکاریا تە هاتە تۆمارکرن ب ژمارە (${orderId})!**`);
        }
    }

    if (botReply.includes('[IMAGE:')) {
        const imgMatch = botReply.match(/\[IMAGE:\s*(.*?)\]/);
        if (imgMatch && imgMatch[1]) {
            const productName = imgMatch[1].toLowerCase().trim();
            const matchedProduct = getProducts().find(p => p.name.toLowerCase().includes(productName));
            botReply = botReply.replace(/\[IMAGE:.*?\]/, '').trim();

            if (botReply.length > 0) await msg.reply(botReply);

            // پشتگیرییا فرە-وێنەیان (Album/Multiple Images)
            if (matchedProduct) {
                const imagesToSend = matchedProduct.images || (matchedProduct.image ? [matchedProduct.image] : []);
                for (const imgUrl of imagesToSend) {
                    try {
                        const media = await MessageMedia.fromUrl(imgUrl);
                        await whatsappClient.sendMessage(msg.from, media, { caption: `${matchedProduct.name} - نرخ: ${matchedProduct.price}` });
                    } catch (e) {
                        console.error('❌ شاشی د فرێکرنا وێنێ واتسئەپێ دا:', e);
                    }
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
if (globalTelegramBot) {
    console.log('🚀 [Telegram Engine]: بۆتێ تێلیگرامێ چالاک بوو!');

    globalTelegramBot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        console.log(`📩 [Telegram DM]: ${msg.text}`);

        let botReply = await generateAiReply(chatId.toString(), msg.text, 'Telegram');

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

                if (botReply) await globalTelegramBot.sendMessage(chatId, botReply);
                
                if (matchedProduct) {
                    const imagesToSend = matchedProduct.images || (matchedProduct.image ? [matchedProduct.image] : []);
                    for (const imgUrl of imagesToSend) {
                        await globalTelegramBot.sendPhoto(chatId, imgUrl, { caption: `${matchedProduct.name} - ${matchedProduct.price}` }).catch(e => console.error(e));
                    }
                }
                return;
            }
        }

        await globalTelegramBot.sendMessage(chatId, botReply);
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
                const webhookEvent = entry.messaging ? entry.messaging[0] : null;
                if (webhookEvent && webhookEvent.message && webhookEvent.message.text) {
                    const senderPsid = webhookEvent.sender.id;
                    const userMessage = webhookEvent.message.text;
                    console.log(`📩 [Meta DM (${body.object})]: ${userMessage}`);

                    let aiReply = await generateAiReply(senderPsid, userMessage, body.object);

                    if (process.env.META_PAGE_ACCESS_TOKEN) {
                        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: aiReply }
                        });
                    }
                }

                if (entry.changes) {
                    for (const change of entry.changes) {
                        if (change.field === 'comments' && change.value && change.value.text) {
                            const commentId = change.value.id;
                            const commentText = change.value.text;
                            console.log(`💬 [Meta Comment]: ${commentText}`);

                            let aiReply = await generateAiReply(commentId, commentText, 'Instagram/FB Comment');

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

            let aiReply = await generateAiReply(senderId, userMessage, 'TikTok');

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
