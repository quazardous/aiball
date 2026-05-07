SHELL := /bin/bash

# ---- Config ---------------------------------------------------------------

HOST          ?= 127.0.0.1
PORT          ?= 7777
URL           := http://$(HOST):$(PORT)

VAR_DIR       := var
PID_FILE      := $(VAR_DIR)/aiball.pid
LOG_FILE      := $(VAR_DIR)/aiball.log

NPM           ?= npm
NODE          ?= node

export AIBALL_HOST := $(HOST)
export AIBALL_PORT := $(PORT)
export AIBALL_URL  := $(URL)

# ---- Help -----------------------------------------------------------------

.DEFAULT_GOAL := help

help:
	@echo "aiball — common targets"
	@echo
	@echo "  make install        install backend + frontend deps"
	@echo "  make start          start daemon in background ($(URL))"
	@echo "  make stop           stop background daemon"
	@echo "  make restart        stop + start"
	@echo "  make status         query daemon health"
	@echo "  make logs           tail -F $(LOG_FILE)"
	@echo "  make dev            run daemon in foreground (tsx watch)"
	@echo
	@echo "  make ui             start Vite dev server (proxy → daemon)"
	@echo "  make ui-build       build frontend → frontend/dist/"
	@echo
	@echo "  make typecheck      tsc --noEmit (back + front)"
	@echo "  make smoke          quick end-to-end smoke test"
	@echo "  make clean          stop daemon, drop frontend/dist + var/"
	@echo
	@echo "  make print-config   show resolved env vars"

print-config:
	@echo "HOST       = $(HOST)"
	@echo "PORT       = $(PORT)"
	@echo "URL        = $(URL)"
	@echo "PID_FILE   = $(PID_FILE)"
	@echo "LOG_FILE   = $(LOG_FILE)"

# ---- Install --------------------------------------------------------------

install: install-backend install-frontend

install-backend:
	$(NPM) install

install-frontend:
	$(NPM) --prefix frontend install

# ---- Daemon ---------------------------------------------------------------

$(VAR_DIR):
	@mkdir -p $(VAR_DIR)

start: $(VAR_DIR)
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	    echo "aiball already running (pid $$(cat $(PID_FILE))) at $(URL)"; \
	    exit 0; \
	fi
	@rm -f $(PID_FILE)
	@echo "starting aiball on $(URL) (logs: $(LOG_FILE))"
	@nohup $(NPM) start >>$(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE)
	@sleep 1
	@if kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	    echo "aiball started (pid $$(cat $(PID_FILE)))"; \
	else \
	    echo "aiball failed to start — see $(LOG_FILE)"; rm -f $(PID_FILE); exit 1; \
	fi

stop:
	@if [ ! -f $(PID_FILE) ]; then \
	    echo "no pid file ($(PID_FILE)) — not running?"; \
	else \
	    PID=$$(cat $(PID_FILE)); \
	    if kill -0 $$PID 2>/dev/null; then \
	        echo "stopping aiball (pid $$PID)"; \
	        kill $$PID; \
	        for _ in 1 2 3 4 5; do kill -0 $$PID 2>/dev/null || break; sleep 0.5; done; \
	        kill -0 $$PID 2>/dev/null && { echo "force-killing"; kill -9 $$PID; }; \
	    else \
	        echo "pid $$PID not alive — cleaning stale pid file"; \
	    fi; \
	    rm -f $(PID_FILE); \
	fi

restart: stop start

status:
	@curl -sS --max-time 2 $(URL)/api/health 2>/dev/null \
	    && echo \
	    || { echo "aiball is down at $(URL)"; exit 1; }

logs:
	@touch $(LOG_FILE) && tail -F $(LOG_FILE)

dev:
	$(NPM) run dev

# ---- Frontend -------------------------------------------------------------

ui:
	$(NPM) --prefix frontend run dev

ui-build:
	$(NPM) --prefix frontend run build

# ---- Quality / smoke ------------------------------------------------------

typecheck:
	$(NPM) run typecheck
	@if [ -d frontend/node_modules ]; then \
	    $(NPM) --prefix frontend exec -- vue-tsc --noEmit; \
	else \
	    echo "(skip frontend typecheck — run 'make install-frontend' first)"; \
	fi

smoke:
	@bash scripts/smoke.sh

# ---- Clean ----------------------------------------------------------------

clean: stop
	@rm -rf $(VAR_DIR) frontend/dist
	@echo "cleaned $(VAR_DIR)/ and frontend/dist/"

.PHONY: help print-config install install-backend install-frontend \
        start stop restart status logs dev \
        ui ui-build typecheck smoke clean
