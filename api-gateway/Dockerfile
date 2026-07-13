FROM registry.access.redhat.com/ubi8/nodejs-18:latest AS builder

COPY package.json .

RUN npm install --production

FROM registry.access.redhat.com/ubi8/nodejs-18:latest

COPY --from=builder /opt/app-root/src/node_modules /opt/app-root/src/node_modules
COPY server.js .

RUN mkdir -p /opt/app-root/src/data && \
    chgrp -R 0 /opt/app-root/src/data && \
    chmod -R g=u /opt/app-root/src/data

USER 1001

EXPOSE 3000

CMD ["node", "server.js"]
