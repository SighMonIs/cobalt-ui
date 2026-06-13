FROM node:20-alpine

# Install nginx and supervisor
RUN apk add --no-cache nginx supervisor

# Set up backend
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

# Set up nginx
COPY nginx.conf /etc/nginx/http.d/default.conf

# Copy frontend
COPY index.html /usr/share/nginx/html/index.html

# Set up supervisor to run both processes
COPY supervisord.conf /etc/supervisord.conf

EXPOSE 80

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
