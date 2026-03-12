FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json .
RUN npm install --omit=dev

FROM node:20-alpine
LABEL org.opencontainers.image.title="Diepvriezer"
LABEL org.opencontainers.image.source="https://github.com/bigbuud/diepvriezer"

RUN apk add --no-cache nginx supervisor

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY server.js .

RUN mkdir -p /usr/share/nginx/html
COPY index.html    /usr/share/nginx/html/
COPY manifest.json /usr/share/nginx/html/
COPY sw.js         /usr/share/nginx/html/

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

VOLUME ["/data"]
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3521
ENTRYPOINT ["/entrypoint.sh"]
