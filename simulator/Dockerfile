FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY simulator.js .
USER node
CMD ["node", "simulator.js"]
