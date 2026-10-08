FROM node:24-alpine
WORKDIR /app
COPY --chmod=0644 core.mjs vertex.mjs server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
