# Local iteration:
#   make dev        vite + tsx watch + uvicorn --reload, bind-mounted source
#
# Production deploy on this (shared) host:
#   make deploy     build (capped concurrency) + apply resource/log limits + up -d + prune
#   make build      just rebuild the images
#   make down       stop and remove containers
#   make logs       follow both services
#   make ps         container status + resource usage

PROD = -f docker-compose.yml -f docker-compose.prod.yml

.PHONY: dev build deploy down logs ps

dev:
	docker compose -f compose.dev.yml up

# COMPOSE_PARALLEL_LIMIT=1: build engine and web one at a time instead of
# both at once, so peak CPU during a rebuild stays modest on a shared box.
build:
	COMPOSE_PARALLEL_LIMIT=1 docker compose $(PROD) build

deploy: build
	docker compose $(PROD) up -d --remove-orphans
	docker image prune -f

down:
	docker compose $(PROD) down

logs:
	docker compose $(PROD) logs -f

ps:
	docker compose $(PROD) ps
	docker stats --no-stream osu2piu-engine-1 osu2piu-web-1
