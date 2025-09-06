# Use Node.js LTS
FROM node:22-alpine

# Install git
RUN apk add --no-cache git

# Working directory
WORKDIR /app

# Clone repo
RUN git clone --depth 1 https://github.com/jpcsit/SMTP2Graph.git .

# Install dependencies & build dist
RUN npm install && npm run build

# Copy startup scripts to /bin
RUN cp dist/server.js /bin/smtp2graph.js && \
    cp docker/startup.sh /bin/startup.sh && \
    cp docker/test.sh /bin/test.sh && \
    chmod +x /bin/startup.sh /bin/test.sh

# Data directory
WORKDIR /data
VOLUME /data

# Expose SMTP port
EXPOSE 587

# Run entrypoint
ENTRYPOINT ["/bin/startup.sh"]