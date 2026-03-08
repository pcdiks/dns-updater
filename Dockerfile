FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY app/package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY app/server.js ./
COPY app/public ./public

# Create data directory
RUN mkdir -p /data

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
