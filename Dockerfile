# ================================
# Kurdish AI Ecosystem - Dockerfile
# ================================
FROM node:20-slim

# دانانا Chromium و پێدڤیێن سیستەمی یێن پێدڤی بۆ puppeteer/whatsapp-web.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libgtk-3-0 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# دانانا جهێ Chromium ب شێوەیەکێ سابیت - نافێری بگۆهۆرت
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# سەرەتا تنێ package.json کۆپی بکە دا cache یا npm install باشتر کار بکەت
COPY package*.json ./
RUN npm install --omit=dev

# ماوەیا کۆدی کۆپی بکە
COPY . .

# پۆرتێ سێرڤەری (Railway ب خۆیایی PORT env دئینیت)
EXPOSE 3000

CMD ["node", "server.js"]
