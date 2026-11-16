# Stage 1: Build Go binaries
FROM golang:1.27-alpine AS builder

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/create-admin ./cmd/create-admin

# Stage 2: Minimal hardened runtime
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S cc25 && \
    adduser -u 10001 -S -G cc25 -H -s /sbin/nologin cc25 && \
    mkdir -p /var/lib/cc25/uploads/slips && \
    chown -R 10001:10001 /var/lib/cc25/uploads && \
    chmod -R 0700 /var/lib/cc25/uploads

WORKDIR /app

COPY --from=builder /out/api /app/api
COPY --from=builder /out/create-admin /app/create-admin

USER 10001:10001

EXPOSE 8000

ENTRYPOINT ["/app/api"]
