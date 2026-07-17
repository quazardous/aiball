SHELL := /bin/bash

# ---- Config ---------------------------------------------------------------

HOST          ?= 127.0.0.1
PORT          ?= 7777
URL           := http://$(HOST):$(PORT)

VAR_DIR       := var
PID_FILE      := $(VAR_DIR)/aiball.pid
LOG_FILE      := $(VAR_DIR)/aiball.log

VITE_PORT     ?= 5173
VITE_PID_FILE := $(VAR_DIR)/vite.pid
VITE_LOG_FILE := $(VAR_DIR)/vite.log

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
	@echo
	@echo "  make dev            HOT-RELOAD STACK: daemon + Vite, both background"
	@echo "                      → open http://127.0.0.1:$(VITE_PORT)"
	@echo "  make dev-stop       stop both"
	@echo "  make dev-logs       tail -F $(VITE_LOG_FILE) (Vite logs)"
	@echo "  make dev-back       run daemon in foreground (tsx watch)"
	@echo
	@echo "  make ui             Vite dev server in foreground (no daemon)"
	@echo "  make ui-build       build frontend → frontend/dist/"
	@echo
	@echo "  make typecheck      tsc --noEmit (back + front)"
	@echo "  make smoke          quick end-to-end smoke test"
	@echo "  make clean          stop daemon + Vite, drop frontend/dist + var/"
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
	@if curl -sS --max-time 1 $(URL)/api/health >/dev/null 2>&1; then \
	    echo "aiball already up at $(URL) (systemd or another launcher)"; \
	elif [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	    echo "aiball already running (pid $$(cat $(PID_FILE))) at $(URL)"; \
	else \
	    rm -f $(PID_FILE); \
	    echo "starting aiball on $(URL) (logs: $(LOG_FILE))"; \
	    nohup $(NPM) start >>$(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
	    sleep 1; \
	    if kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	        echo "aiball started (pid $$(cat $(PID_FILE)))"; \
	    else \
	        echo "aiball failed to start — see $(LOG_FILE)"; rm -f $(PID_FILE); exit 1; \
	    fi; \
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

dev-back:
	$(NPM) run dev

# ---- Hot-reload stack (daemon + Vite, both background) -------------------

dev: start ui-bg
	@printf "\n→ open \033[1mhttp://127.0.0.1:$(VITE_PORT)\033[0m for the hot-reload UI\n"
	@printf "  (production build still served at $(URL) when frontend/dist/ exists)\n"

dev-stop: ui-stop stop

dev-logs:
	@touch $(VITE_LOG_FILE) && tail -F $(VITE_LOG_FILE)

ui-bg: $(VAR_DIR)
	@if [ -f $(VITE_PID_FILE) ] && kill -0 $$(cat $(VITE_PID_FILE)) 2>/dev/null; then \
	    echo "vite already running (pid $$(cat $(VITE_PID_FILE))) at http://127.0.0.1:$(VITE_PORT)"; \
	else \
	    rm -f $(VITE_PID_FILE); \
	    if [ ! -d frontend/node_modules ]; then \
	        echo "frontend/node_modules missing — running 'make install-frontend' first"; \
	        $(MAKE) install-frontend; \
	    fi; \
	    echo "starting vite on http://127.0.0.1:$(VITE_PORT) (logs: $(VITE_LOG_FILE))"; \
	    nohup $(NPM) --prefix frontend run dev -- \
	        --host 127.0.0.1 --port $(VITE_PORT) --strictPort \
	        >>$(VITE_LOG_FILE) 2>&1 < /dev/null & echo $$! > $(VITE_PID_FILE); \
	    sleep 2; \
	    if kill -0 $$(cat $(VITE_PID_FILE)) 2>/dev/null; then \
	        echo "vite started (pid $$(cat $(VITE_PID_FILE)))"; \
	    else \
	        echo "vite failed to start — see $(VITE_LOG_FILE)"; rm -f $(VITE_PID_FILE); exit 1; \
	    fi; \
	fi

ui-stop:
	@if [ ! -f $(VITE_PID_FILE) ]; then \
	    echo "no vite pid file ($(VITE_PID_FILE)) — not running?"; \
	else \
	    PID=$$(cat $(VITE_PID_FILE)); \
	    if kill -0 $$PID 2>/dev/null; then \
	        echo "stopping vite (pid $$PID)"; \
	        pkill -TERM -P $$PID 2>/dev/null || true; \
	        kill -TERM $$PID 2>/dev/null || true; \
	        for _ in 1 2 3 4 5; do kill -0 $$PID 2>/dev/null || break; sleep 0.5; done; \
	        if kill -0 $$PID 2>/dev/null; then \
	            echo "force-killing"; \
	            pkill -KILL -P $$PID 2>/dev/null || true; \
	            kill -KILL $$PID 2>/dev/null || true; \
	        fi; \
	    else \
	        echo "pid $$PID not alive — cleaning stale pid file"; \
	    fi; \
	    rm -f $(VITE_PID_FILE); \
	fi

# ---- Frontend -------------------------------------------------------------

ui:
	$(NPM) --prefix frontend run dev -- --host 127.0.0.1 --port $(VITE_PORT)

ui-build:
	$(NPM) --prefix frontend run build

# ---- Quality / smoke ------------------------------------------------------

typecheck:
	$(NPM) run typecheck
# `npm --prefix X exec` resolves the BINARY from X but leaves the cwd here, so
# vue-tsc picked up the ROOT tsconfig and re-checked the backend — the frontend
# leg was a silent no-op that always went green. vue-tsc has no project flag we
# can trust here (it resolves `include` relative to cwd), so cd for real.
	@if [ -d frontend/node_modules ]; then \
	    cd frontend && $(NPM) exec -- vue-tsc --noEmit; \
	else \
	    echo "(skip frontend typecheck — run 'make install-frontend' first)"; \
	fi
	@if [ -d contrib/mini-admin/node_modules ]; then \
	    cd contrib/mini-admin && $(NPM) exec -- vue-tsc --noEmit; \
	else \
	    echo "(skip contrib typecheck — run 'npm --prefix contrib/mini-admin install' first)"; \
	fi

smoke:
	@bash scripts/smoke.sh

# ---- Clean ----------------------------------------------------------------

clean: ui-stop stop
	@rm -rf $(VAR_DIR) frontend/dist
	@echo "cleaned $(VAR_DIR)/ and frontend/dist/"

.PHONY: help print-config install install-backend install-frontend \
        start stop restart status logs dev-back \
        dev dev-stop dev-logs ui ui-bg ui-stop ui-build \
        typecheck smoke clean
