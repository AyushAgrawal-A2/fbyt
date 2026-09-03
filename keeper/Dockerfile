# syntax=docker/dockerfile:1
# Build the Rust keeper. Build context must be the REPO ROOT — the keeper path-depends on the
# fbyt_vault program crate (for its state/accounts/instruction types).
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY programs ./programs
COPY keeper ./keeper
WORKDIR /src/keeper
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/keeper/target \
    cargo build --release && cp target/release/fbyt-keeper /usr/local/bin/fbyt-keeper

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/fbyt-keeper /usr/local/bin/fbyt-keeper
ENV FBYT_DB_PATH=/data/fbyt.db
# RPC_URL is the Solana RPC endpoint — set it at runtime (compose/env) to your devnet/mainnet provider.
ENV KEEPER_INTERVAL_SEC=30
# the delegate keypair is provided as a mounted secret file, never baked into the image:
#   docker run -v /run/secrets/delegate.json:/keys/delegate.json ... fbyt-keeper /keys/delegate.json
ENTRYPOINT ["fbyt-keeper"]
