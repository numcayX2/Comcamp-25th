# Stage 1: Astro static build
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ARG PUBLIC_API_URL=/api
ARG PUBLIC_TURNSTILE_SITE_KEY
ARG PUBLIC_GALLERY_BASE_URL=https://comcamp25-gallery.sokulshop5.workers.dev/
# Public origin for canonical / og:url / og:image (compose defaults it to FRONTEND_URL). Empty = those tags are omitted.
ARG PUBLIC_SITE_URL

ENV PUBLIC_API_URL=${PUBLIC_API_URL}
ENV PUBLIC_TURNSTILE_SITE_KEY=${PUBLIC_TURNSTILE_SITE_KEY}
ENV PUBLIC_GALLERY_BASE_URL=${PUBLIC_GALLERY_BASE_URL}
ENV PUBLIC_SITE_URL=${PUBLIC_SITE_URL}
ENV NODE_ENV=production

# Fail fast if Turnstile site key is empty, placeholder, or Cloudflare's dummy test keys.
RUN case "${PUBLIC_TURNSTILE_SITE_KEY}" in \
      ""|CHANGE_ME*|change_this*|REPLACE_WITH*|1x00000000000000000000AA|2x00000000000000000000AB|3x00000000000000000000FF) \
        echo "ERROR: PUBLIC_TURNSTILE_SITE_KEY must be set to a real Cloudflare Turnstile site key" >&2; \
        exit 1 ;; \
    esac

RUN npm run build

# Stage 2: Nginx static server on port 4321
FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf && \
    mkdir -p /etc/nginx/snippets

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/snippets/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# Strip potential Windows CRLF (\r), remove root-only `user` directive, point PID to /tmp,
# and run Nginx directly as non-root `nginx` compatible with read_only rootfs.
RUN sed -i 's/\r$//' /etc/nginx/conf.d/default.conf /etc/nginx/snippets/security-headers.conf && \
    sed -i '/^user[[:space:]]/d; s|/var/run/nginx.pid|/tmp/nginx.pid|g; s|/run/nginx.pid|/tmp/nginx.pid|g' /etc/nginx/nginx.conf && \
    chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /etc/nginx/snippets

USER nginx

EXPOSE 4321

ENTRYPOINT ["nginx", "-g", "daemon off;"]
