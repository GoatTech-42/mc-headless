# mc-headless — headless Minecraft 1.18.2 (Fabric) + MineScript 3.2 + dashboard sidecar
#
# Base image already ships Java 8/17/21 and the `hmc` CLI (wrapper jar lives in /headlessmc).
# MC 1.18.2 runs on Java 17 (bundled at /opt/java/java17).
FROM 3arthqu4ke/headlessmc:latest

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# --- Python 3.10 ---
# MineScript 3.2 expects `python3` at /usr/bin/python3 on Linux. Base is Ubuntu noble
# (24.04) which ships python3.12 (unsupported by MineScript 3.2), so pull 3.10 from deadsnakes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg software-properties-common \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3.10 python3.10-distutils \
 && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
 && ln -sf /usr/bin/python3.10 /usr/bin/python \
 && rm -rf /var/lib/apt/lists/*

# --- Node 20.x (dashboard sidecar, same container) ---
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# software GL via llvmpipe for headless texture loading
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb mesa-utils libgl1 libgl1-mesa-dri \
 && rm -rf /var/lib/apt/lists/*

# /data       = HeadlessMC home (versions, .minecraft, minescript scripts) + logs  [mc-data volume]
# /app/data   = dashboard token  [volume]
# /app/scripts= user scripts baked into the image (copied to minescript dir at runtime)
ENV HMC_HOME=/data \
    MC_GDIR=/data/.minecraft \
    JAVA_XMX=1536M

RUN mkdir -p /data/logs /app/data /app/scripts

COPY package.json server.js /app/
COPY public/ /app/public/
COPY scripts/ /app/scripts/
RUN cd /app && npm install --production

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

VOLUME ["/data", "/app/data"]
EXPOSE 3000

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
