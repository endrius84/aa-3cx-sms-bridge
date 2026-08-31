ARG BUILD_FROM
FROM $BUILD_FROM

# HA base images are Alpine-based; install Node.js + bashio helper deps
RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY src/package.json src/package-lock.json* ./
RUN npm install --omit=dev
COPY src/ ./

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
