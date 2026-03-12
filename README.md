# 🧊 Diepvriezer

Inventarisatie app voor twee diepvriezers. Met GV/NGV markering, categorieën en datum ingevroren.

## Docker (Synology)

```bash
docker run -d \
  --name=diepvriezer \
  -p 3521:3521 \
  -e PUID=1026 \
  -e PGID=100 \
  -e TZ=Europe/Brussels \
  -e APP_USER=gebruiker \
  -e APP_PASSWORD=wachtwoord \
  -v /volume1/docker/diepvriezer:/data \
  --restart always \
  ghcr.io/bigbuud/diepvriezer:latest
```

## Portainer stack

```yaml
services:
  diepvriezer:
    image: ghcr.io/bigbuud/diepvriezer:latest
    container_name: diepvriezer
    ports:
      - "3521:3521"
    environment:
      - TZ=Europe/Brussels
      - APP_USER=gebruiker
      - APP_PASSWORD=wachtwoord
    volumes:
      - /volume1/docker/diepvriezer:/data
    restart: always
```

## Categorieën
vlees · vis · groenten · fruit · snacks · soepen · brood/gebak · kant-en-klaar · zuivel/eieren · ijs/desserts · overige

## GV / NGV
- **GV** = Glutenvrij
- **NGV** = Niet glutenvrij
