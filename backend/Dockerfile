FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
RUN mkdir -p /app/uploads /app/changelog
EXPOSE 3000
CMD ["node", "src/server.js"]
