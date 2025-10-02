# 1. Build aşaması
FROM node:20-alpine AS builder

# Çalışma klasörü
WORKDIR /app

# package.json ve lock dosyalarını kopyala
COPY package*.json ./

# Bağımlılıkları yükle
RUN npm ci

# Uygulama kodunu kopyala
COPY . .

# Remix build işlemi
RUN npm run build

# 2. Production aşaması
FROM node:18-alpine AS runner

WORKDIR /app
ENV NODE_ENV production

# package.json ve lock dosyalarını kopyala
COPY package*.json ./

# Sadece production bağımlılıklarını yükle
RUN npm ci --omit=dev

# Build çıktısı ve public dosyalarını builder’dan al
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public

# Diğer gerekli dosyaları kopyala (ör: routes, config vs.)
COPY . .

# Fly.io port ayarı
ENV PORT 8080
EXPOSE 8080

# Uygulama başlatma komutu
CMD ["npm", "run", "start"]