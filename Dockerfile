FROM golang:alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/nnaper-server .

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata || true
WORKDIR /app

COPY --from=builder /out/nnaper-server /usr/local/bin/nnaper-server
COPY maps /app/maps
COPY assets /app/assets

RUN chmod +x /usr/local/bin/nnaper-server

EXPOSE 8000

ENV PORT=8000
CMD ["/usr/local/bin/nnaper-server"]

