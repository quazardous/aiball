# The upgrade test's machine: a user with nothing of aiball's, and what
# install.sh asks for (node, npm, rsync, git, curl). No systemd, no cargo: the
# installer says so and carries on, as it does on such a machine.
FROM node:22-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends rsync \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash pilot
USER pilot
WORKDIR /home/pilot
ENV PATH=/home/pilot/.local/bin:$PATH
CMD ["bash", "/src/tests/upgrade/upgrade.sh"]
