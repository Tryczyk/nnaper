FROM golang:alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/nnaper-server .

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata curl && \
    adduser -D -u 1000 appuser

WORKDIR /app

COPY --from=builder /out/nnaper-server /usr/local/bin/nnaper-server

RUN chmod +x /usr/local/bin/nnaper-server && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

ENV PORT=8000
CMD ["/usr/local/bin/nnaper-server"]
