# my-home na vm-prod (Oracle, arm64): jeden obraz z serwerem i klientem. Render i praca lokalna nie używają tego pliku.
# Buduje go serwer vm-prod: oracle-cloud/vm-prod/.deploy-my-home/deploy-my-home.sh wysyła git archive commitu do docker build
# (od 2026-11-08; wcześniej GitHub Actions i ghcr.io). main to kanał prod, develop to kanał test.
# Sekrety są tylko w zmiennych środowiskowych na serwerze, nie trafiają do obrazu.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# --ignore-scripts: testowy mongodb-memory-server pobierałby przy instalacji binarkę MongoDB
RUN npm ci --ignore-scripts -w server -w client
COPY server server
COPY client client
RUN npm run build -w server
# Klient łączy się z adresem, z którego otwarto stronę (client/src/core/http.ts), więc obraz działa pod każdym adresem.
RUN VITE_SERVER_URL=same-origin npm run build -w client

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV CLIENT_DIR=/app/client/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --ignore-scripts -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
WORKDIR /app/server
# Użytkownik z konta na serwerze (UID 1998), ustawiany w docker-compose.yml.
# Polecenia na serwerze (od 2026-11-13, server/src/core/cli.ts), w działającym kontenerze, bez hasła:
#   docker exec my-home-prod node dist/server.js --kod-awaryjny        kod konta system (5 min) bez poczty
#   docker exec -i my-home-prod node dist/server.js --api PUT '/firmware/<rodzaj>/<wersja>?description=…' --bin < plik.bin
CMD ["node", "dist/server.js"]
