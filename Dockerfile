# Despliegue en Railway: construye la SPA y la sirve como estático con fallback
# de rutas (para que /kds, /t/:token, etc. funcionen al recargar).

# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Config de Firebase (pública) inyectada por Vite en tiempo de build.
# Railway las pasa como build args desde las Variables del servicio.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_USE_EMULATORS=false
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
    VITE_USE_EMULATORS=$VITE_USE_EMULATORS
RUN npm run build

# --- serve ---
FROM node:22-alpine AS serve
WORKDIR /app
RUN npm i -g serve@14
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
# -s = single-page app: cualquier ruta cae en index.html
CMD ["sh", "-c", "serve -s dist -l tcp://0.0.0.0:$PORT"]
