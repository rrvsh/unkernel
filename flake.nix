# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Rafiq bin Mohamad
{
  description = "Linux on WebAssembly, with a mutable NixOS guest experiment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      guestSystem = "aarch64-linux";
      hostSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forHostSystems = lib.genAttrs hostSystems;

      mkEpoxyServer =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          rev = "9cde724aea1a0f5e46b1c962b3d19ca1389af074";
        in
        pkgs.rustPlatform.buildRustPackage {
          pname = "epoxy-server";
          version = "2.0.0-${builtins.substring 0 7 rev}";

          src = pkgs.fetchFromGitHub {
            owner = "MercuryWorkshop";
            repo = "epoxy-tls";
            inherit rev;
            hash = "sha256-jPLMAPmqwAkHc+bg2tbfYv/c/O2B5uV+yaD/qU+V+EM=";
          };

          cargoHash = "sha256-fSlSimvs4LoI1H8MQp+/XP8Qw+GO1Jd3OIMC1hc5FmE=";
          cargoBuildFlags = [
            "--package"
            "epoxy-server"
          ];
          cargoTestFlags = [
            "--package"
            "epoxy-server"
          ];

          preBuild = ''
            unset JEMALLOC_OVERRIDE LIBGIT2_NO_VENDOR
          '';

          postPatch = ''
            cat > server/build.rs <<'RUST'
            fn main() {
                println!("cargo:rustc-env=VERGEN_GIT_SHA=${rev}");
                println!("cargo:rustc-env=VERGEN_GIT_DIRTY=false");
                println!("cargo:rustc-env=VERGEN_RUSTC_SEMVER=unknown");
                println!("cargo:rustc-env=VERGEN_RUSTC_HOST_TRIPLE=unknown");
            }
            RUST
          '';
        };

      mkWeb =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          release = "v0.2.0-261122-4e58555";
          asset = name: "https://github.com/pithings/unkernel/releases/download/${release}/${name}";
          kernel = pkgs.fetchurl {
            url = asset "unkernel.wasm";
            hash = "sha256-tBCgr9xN+mFXcQRacK4NPVLYeh5PqX/qQuB+g77+iYg=";
          };
          debian = pkgs.fetchurl {
            url = asset "debian.erofs";
            hash = "sha256-COg0Sq6Xz6izEibaVT/kCeOVknkNisXduZKPRTAlFYc=";
          };
          distros = pkgs.runCommand "unkernel-distros" { } ''
            mkdir "$out"
            ln -s ${debian} "$out/debian.erofs"
            cat > "$out/distros.json" <<'JSON'
            ${builtins.toJSON {
              abi = 3;
              base = "base-67d2aabad8b73f64";
              distros = [
                {
                  name = "debian";
                  file = "debian.erofs";
                  size = 72749056;
                  sha256 = "08e8344aae97cfa8b31226da553fe409e39592790d8ac5ddb9928f4530251587";
                  image = "debian-13.7-88f3040591485cc9";
                }
              ];
            }}
            JSON
          '';
        in
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "unkernel-web";
          version = "0.2.0-phone";
          src = self;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            inherit (pkgs) pnpm;
            fetcherVersion = 4;
            hash = "sha256-LIJiLIq/xd4efrRCiSmWLTtYaGX35Hnm2M/1/YQc50M=";
          };

          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];

          buildPhase = ''
            runHook preBuild
            export KW_KERNEL=${kernel}
            export KW_DISTROS=${distros}
            export KW_GL=0
            pnpm -C web build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            cp -R web/.output "$out"
            runHook postInstall
          '';
        });

      mkGuest =
        {
          configuration ? { },
          diskSize ? "auto",
          additionalSpace ? "2G",
        }:
        let
          nixos = lib.nixosSystem {
            system = guestSystem;
            modules = [
              "${nixpkgs}/nixos/modules/profiles/minimal.nix"
              ./nix/guest.nix
              configuration
            ];
          };
          initialSystem = nixos.config.system.build.toplevel;
          initialInit = nixos.pkgs.writeShellScript "unkernel-nixos-init" ''
            activeSystem="$(${nixos.pkgs.coreutils}/bin/readlink -f /nix/var/nix/profiles/system)"
            ${nixos.pkgs.coreutils}/bin/ln -sfn "$activeSystem" /run/current-system
            ${nixos.pkgs.coreutils}/bin/ln -sfn "$activeSystem" /run/booted-system

            if [[ ! -e /var/lib/unkernel/initialised ]]; then
              ${nixos.pkgs.util-linux}/bin/mount -t proc proc /proc
              ${nixos.pkgs.nix}/bin/nix-store --load-db < /nix-path-registration
              "$activeSystem/activate" || true
              ${nixos.pkgs.coreutils}/bin/mkdir -p /var/lib/unkernel
              ${nixos.pkgs.coreutils}/bin/touch /var/lib/unkernel/initialised
            fi
            exec "$activeSystem/init"
          '';
          rootImage = nixos.pkgs.callPackage "${nixpkgs}/nixos/lib/make-ext4-fs.nix" {
            storePaths = [
              initialInit
              initialSystem
            ];
            volumeLabel = "nixos";
            populateImageCommands = ''
              mkdir -p \
                ./files/bin \
                ./files/dev \
                ./files/etc \
                ./files/home \
                ./files/nix/var/nix/db \
                ./files/nix/var/nix/gcroots \
                ./files/nix/var/nix/profiles \
                ./files/proc \
                ./files/root \
                ./files/run \
                ./files/sbin \
                ./files/sys \
                ./files/tmp \
                ./files/usr/bin \
                ./files/var/lib \
                ./files/var/log \
                ./files/var/tmp
              chmod 1777 ./files/tmp ./files/var/tmp
              ln -s ${initialSystem} ./files/nix/var/nix/profiles/system
              ln -s ${initialInit} ./files/nix/var/nix/gcroots/unkernel-init
              ln -s /nix/var/nix/profiles/system/sw/bin/sh ./files/bin/sh
              ln -s ${initialInit} ./files/sbin/init
              ln -s /nix/var/nix/profiles/system/sw/bin/env ./files/usr/bin/env
            '';
          };
          targetSize = if diskSize == "auto" then "+${additionalSpace}" else "${toString diskSize}M";
          image =
            nixos.pkgs.runCommand "unkernel-nixos-image"
              {
                nativeBuildInputs = [ nixos.pkgs.e2fsprogs ];
              }
              ''
                mkdir "$out"
                cp --reflink=auto --sparse=always ${rootImage} "$out/unkernel-nixos.img"
                chmod u+w "$out/unkernel-nixos.img"
                truncate -s ${lib.escapeShellArg targetSize} "$out/unkernel-nixos.img"
                resize2fs "$out/unkernel-nixos.img"
              '';
          seedId = builtins.baseNameOf initialSystem;
          seed =
            nixos.pkgs.runCommand "unkernel-nixos-seed"
              {
                nativeBuildInputs = [ nixos.pkgs.nodejs_24 ];
              }
              ''
                mkdir "$out"
                node ${self}/kernel/tools/kwsparse.mjs encode \
                  ${image}/unkernel-nixos.img -o "$out/unkernel-nixos.kwsparse"
                cat > "$out/manifest.json" <<'JSON'
                ${builtins.toJSON {
                  version = 1;
                  inherit seedId;
                  system = toString initialSystem;
                  image = "unkernel-nixos.kwsparse";
                }}
                JSON
              '';
        in
        {
          inherit
            image
            nixos
            seed
            seedId
            ;
          system = initialSystem;
        };

      defaultGuest = mkGuest { };
    in
    {
      lib = {
        inherit mkGuest;
      };

      nixosModules.default = import ./nix/module.nix { inherit self; };

      packages = forHostSystems (system: {
        default = defaultGuest.seed;
        epoxy-server = mkEpoxyServer system;
        guest-image = defaultGuest.image;
        guest-seed = defaultGuest.seed;
        guest-system = defaultGuest.system;
        web = mkWeb system;
      });

      formatter = forHostSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      checks = forHostSystems (_: {
        guest-system = defaultGuest.system;
      });
    };
}
