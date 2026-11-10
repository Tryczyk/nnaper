FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY nnaper-server /app/nnaper-server
COPY maps /app/maps
COPY assets /app/assets

RUN chmod +x /app/nnaper-server

EXPOSE 8000

ENV PORT=8000
CMD ["/app/nnaper-server"]
