# The yt-dlp runner. See server.mjs for why this exists and what it refuses.
#
# yt-dlp is a Python program; this image carries Python and Node side by side
# because the service is Node and the tool is not. It is deliberately built on
# the official yt-dlp release rather than `pip install yt-dlp` at build time, so
# the version in the image is a version somebody chose and can read off a log
# line, not whatever PyPI served that morning. YouTube's extractors break often
# enough that "which yt-dlp is this" is the first question of any outage.

FROM node:22-alpine

# `ffmpeg` is not installed on purpose. This service only ever runs
# `--flat-playlist -J` (a listing) and `--print urls` (which implies
# --simulate). Neither downloads or muxes a byte of media, so ffmpeg would be
# ~80MB of image carrying capability the service is designed not to have.
RUN apk add --no-cache python3 ca-certificates

# Pin the version. Bump it deliberately when an extractor breaks.
ARG YTDLP_VERSION=2026.07.04
RUN wget -q -O /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
 && chmod +x /usr/local/bin/yt-dlp \
 && /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY server.mjs ./

# Not root. The service spawns processes; if one is ever induced to do something
# unintended, it should not be doing it as root.
USER node

ENV PORT=8080
EXPOSE 8080

# Cookies, if this host needs them. NOT baked into the image — a cookies.txt is
# a live signed-in session, it expires, and an image is a thing people copy.
# Mount it read-only and point the service at it:
#
#   docker run -v /srv/ytdlp/cookies.txt:/run/secrets/cookies.txt:ro \
#              -e YTDLP_COOKIES_FILE=/run/secrets/cookies.txt ...
#
# The file must be readable by the unprivileged user this container runs as.

# No HEALTHCHECK that shells out to curl — the image does not carry curl, and
# the service answers GET /health itself for the platform to poll.
CMD ["node", "server.mjs"]
