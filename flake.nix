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
            if [[ ! -e /var/lib/unkernel/initialised ]]; then
              ${nixos.pkgs.util-linux}/bin/mount -t proc proc /proc
              ${nixos.pkgs.nix}/bin/nix-store --load-db < /nix-path-registration
              ${initialSystem}/activate || true
              ${nixos.pkgs.coreutils}/bin/mkdir -p /var/lib/unkernel
              ${nixos.pkgs.coreutils}/bin/touch /var/lib/unkernel/initialised
            fi
            exec ${initialSystem}/init
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
        in
        {
          inherit image nixos;
          system = nixos.config.system.build.toplevel;
        };

      defaultGuest = mkGuest { };
    in
    {
      lib = {
        inherit mkGuest;
      };

      nixosModules.default = import ./nix/module.nix { inherit self; };

      packages = forHostSystems (_: {
        default = defaultGuest.image;
        guest-image = defaultGuest.image;
        guest-system = defaultGuest.system;
      });

      formatter = forHostSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      checks = forHostSystems (_: {
        guest-system = defaultGuest.system;
      });
    };
}
