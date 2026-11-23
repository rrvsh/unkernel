# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Rafiq bin Mohamad
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    concatMapAttrs
    escapeURL
    filterAttrs
    mapAttrs
    mkEnableOption
    mkIf
    mkOption
    optional
    recursiveUpdate
    replaceStrings
    types
    ;
  cfg = config.services.unkernel;
  enabledInstances = filterAttrs (_: instance: instance.enable) cfg.instances;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  web = packages.web;
  publicUrl = if cfg.publicUrl == null then null else lib.removeSuffix "/" cfg.publicUrl;
  cacheUrl = if publicUrl == null || !cfg.cache.enable then null else "${publicUrl}/cache";
  wispUrl =
    if cfg.wisp.url != null then
      cfg.wisp.url
    else if cfg.wisp.enable && publicUrl != null then
      "${replaceStrings [ "https://" "http://" ] [ "wss://" "ws://" ] publicUrl}/wisp/"
    else
      null;
  isolationHeaders = ''
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  '';
  wispConfig = pkgs.writeText "unkernel-wisp.json" (
    builtins.toJSON (
      recursiveUpdate {
        server = {
          bind = [
            "tcp"
            "127.0.0.1:${toString cfg.wisp.port}"
          ];
          use_real_ip_headers = true;
        };
        stream = {
          allow_loopback = false;
          allow_multicast = false;
          allow_non_global = false;
        };
      } cfg.wisp.settings
    )
  );

  instanceData = mapAttrs (
    name: instance:
    let
      manifestUrl = if publicUrl == null then null else "${publicUrl}/machines/${name}/generation.json";
      upgradeTool =
        guestPkgs:
        guestPkgs.writeShellApplication {
          name = "unkernel-upgrade";
          runtimeInputs = [
            guestPkgs.coreutils
            guestPkgs.curl
            guestPkgs.jq
            guestPkgs.nix
          ];
          text = ''
            action="''${1:-check}"
            ${
              if manifestUrl == null then
                ''
                  echo "This machine has no upgrade manifest URL. Set services.unkernel.publicUrl on its host." >&2
                  exit 1
                ''
              else
                ''
                  manifest="$(${guestPkgs.curl}/bin/curl --fail --silent --show-error ${lib.escapeShellArg manifestUrl})"
                  system="$(printf '%s' "$manifest" | ${guestPkgs.jq}/bin/jq -er .system)"
                  cache="$(printf '%s' "$manifest" | ${guestPkgs.jq}/bin/jq -r '.cache // empty')"
                  current="$(readlink -f /nix/var/nix/profiles/system)"
                  case "$action" in
                    check)
                      printf 'current:   %s\navailable: %s\n' "$current" "$system"
                      [[ "$current" == "$system" ]] && echo "up to date" || echo "upgrade available"
                      ;;
                    upgrade)
                      if [[ -z "$cache" ]]; then
                        echo "The host has not enabled its signed binary cache." >&2
                        exit 1
                      fi
                      nix copy --from "$cache" "$system"
                      nix-env --profile /nix/var/nix/profiles/system --set "$system"
                      if ! "$system/bin/switch-to-configuration" switch; then
                        nix-env --profile /nix/var/nix/profiles/system --set "$current"
                        "$current/bin/switch-to-configuration" switch || true
                        echo "Activation failed; restored $current" >&2
                        exit 1
                      fi
                      echo "activated $system"
                      ;;
                    rollback)
                      nix-env --profile /nix/var/nix/profiles/system --rollback
                      system="$(readlink -f /nix/var/nix/profiles/system)"
                      if ! "$system/bin/switch-to-configuration" switch; then
                        nix-env --profile /nix/var/nix/profiles/system --set "$current"
                        "$current/bin/switch-to-configuration" switch || true
                        echo "Rollback activation failed; restored $current" >&2
                        exit 1
                      fi
                      echo "rolled back to $system"
                      ;;
                    generations)
                      nix-env --profile /nix/var/nix/profiles/system --list-generations
                      ;;
                    gc)
                      nix-env --profile /nix/var/nix/profiles/system --delete-generations old
                      nix-store --gc
                      ;;
                    *)
                      echo "usage: unkernel-upgrade [check|upgrade|rollback|generations|gc]" >&2
                      exit 2
                      ;;
                  esac
                ''
            }
          '';
        };
      guest = self.lib.mkGuest {
        inherit (instance) additionalSpace;
        diskSize = if instance.diskSize == null then "auto" else instance.diskSize;
        configuration =
          { pkgs, ... }:
          {
            imports = [ instance.configuration ];
            nix.settings.trusted-public-keys = optional cfg.cache.enable cfg.cache.publicKey;
            environment.systemPackages = [ (upgradeTool pkgs) ];
          };
      };
      generation = pkgs.writeText "unkernel-${name}-generation.json" (
        builtins.toJSON {
          version = 1;
          inherit (guest) seedId;
          system = toString guest.system;
          cache = cacheUrl;
        }
      );
      query = lib.concatStringsSep "&" (
        [
          "disk=${escapeURL "/machines/${name}/unkernel-nixos.kwsparse"}"
          "machine=${escapeURL instance.seedName}"
          "disk-version=${escapeURL instance.diskVersion}"
          "seed=${escapeURL guest.seedId}"
          "generation=${escapeURL "/machines/${name}/generation.json"}"
        ]
        ++ optional (wispUrl != null) "wisp=${escapeURL wispUrl}"
      );
    in
    {
      inherit generation guest query;
    }
  ) enabledInstances;

  instanceLocations = concatMapAttrs (name: value: {
    "= /instances/${name}" = {
      extraConfig = ''
        ${isolationHeaders}
        return 302 /?${value.query};
      '';
    };
    "= /machines/${name}/unkernel-nixos.kwsparse" = {
      alias = "${value.guest.seed}/unkernel-nixos.kwsparse";
      extraConfig = ''
        ${isolationHeaders}
        add_header Cache-Control "no-store" always;
        add_header Accept-Ranges "bytes" always;
        gzip off;
      '';
    };
    "= /machines/${name}/seed.json" = {
      alias = "${value.guest.seed}/manifest.json";
      extraConfig = ''
        ${isolationHeaders}
        add_header Cache-Control "no-store" always;
      '';
    };
    "= /machines/${name}/generation.json" = {
      alias = value.generation;
      extraConfig = ''
        ${isolationHeaders}
        add_header Cache-Control "no-store" always;
      '';
    };
  }) instanceData;
in
{
  options.services.unkernel = {
    enable = mkEnableOption "unkernel browser guests";

    listenAddress = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address on which the browser application listens.";
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "Port on which the browser application listens.";
    };

    runtimePort = mkOption {
      type = types.port;
      default = 8081;
      description = "Loopback port used by the unkernel web runtime.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the browser application port in the firewall.";
    };

    publicUrl = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "https://shell.example.com";
      description = "Public origin used by guests to fetch signed upgrades.";
    };

    wisp = {
      enable = mkEnableOption "a local Wisp network proxy";

      url = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "wss://wisp.example.com/";
        description = "External Wisp URL, or null to derive /wisp/ from publicUrl when hosting Wisp.";
      };

      port = mkOption {
        type = types.port;
        default = 4000;
        description = "Loopback port used by the Wisp server.";
      };

      package = mkOption {
        type = types.package;
        default = packages.epoxy-server;
        defaultText = lib.literalExpression "self.packages.\${pkgs.system}.epoxy-server";
        description = "Wisp server package providing bin/epoxy-server.";
      };

      settings = mkOption {
        type = types.attrsOf types.anything;
        default = { };
        description = "Epoxy Server settings merged over the secure local defaults.";
      };
    };

    cache = {
      enable = mkEnableOption "the signed guest binary cache";

      port = mkOption {
        type = types.port;
        default = 5000;
        description = "Loopback port used by nix-serve.";
      };

      secretKeyFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "Host path to the binary-cache secret signing key.";
      };

      publicKey = mkOption {
        type = types.str;
        default = "";
        example = "unkernel-1:base64-public-key";
        description = "Matching public key baked into every guest.";
      };
    };

    instances = mkOption {
      default = { };
      description = "Named mutable NixOS browser guests.";
      type = types.attrsOf (
        types.submodule (
          { name, ... }:
          {
            options = {
              enable = mkEnableOption "the ${name} unkernel guest" // {
                default = true;
              };

              configuration = mkOption {
                type = types.deferredModule;
                default = { };
                description = "NixOS module applied to this aarch64 guest.";
              };

              diskSize = mkOption {
                type = types.nullOr types.ints.positive;
                default = null;
                example = 8192;
                description = "Fixed seed disk size in MiB, or null to size it automatically.";
              };

              additionalSpace = mkOption {
                type = types.str;
                default = "2G";
                description = "Free space added when diskSize is null.";
              };

              seedName = mkOption {
                type = types.strMatching "[a-zA-Z0-9._-]+";
                default = name;
                description = "Stable browser machine identity. Changing it creates a new machine.";
              };

              diskVersion = mkOption {
                type = types.strMatching "[a-zA-Z0-9._-]+";
                default = "v1";
                description = "Persistent disk-format version. Changing it requires an explicit new machine or import.";
              };
            };
          }
        )
      );
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = enabledInstances != { };
        message = "services.unkernel.enable requires at least one enabled instance";
      }
      {
        assertion = !cfg.cache.enable || cfg.cache.secretKeyFile != null;
        message = "services.unkernel.cache.secretKeyFile is required when the cache is enabled";
      }
      {
        assertion = !cfg.cache.enable || cfg.cache.publicKey != "";
        message = "services.unkernel.cache.publicKey is required when the cache is enabled";
      }
      {
        assertion = !cfg.cache.enable || cfg.publicUrl != null;
        message = "services.unkernel.publicUrl is required when the cache is enabled";
      }
      {
        assertion = publicUrl == null || builtins.match "https?://[^/]+" publicUrl != null;
        message = "services.unkernel.publicUrl must be an HTTP(S) origin without a path";
      }
      {
        assertion = wispUrl == null || builtins.match "wss?://.+" wispUrl != null;
        message = "services.unkernel.wisp.url must use ws:// or wss://";
      }
      {
        assertion = cfg.runtimePort != cfg.port;
        message = "services.unkernel.runtimePort must differ from services.unkernel.port";
      }
      {
        assertion =
          !cfg.cache.enable
          || !builtins.elem cfg.cache.port [
            cfg.port
            cfg.runtimePort
          ];
        message = "services.unkernel.cache.port must not conflict with the web ports";
      }
      {
        assertion =
          !cfg.wisp.enable
          || !builtins.elem cfg.wisp.port (
            [
              cfg.port
              cfg.runtimePort
            ]
            ++ optional cfg.cache.enable cfg.cache.port
          );
        message = "services.unkernel.wisp.port must not conflict with the web or cache ports";
      }
      {
        assertion = !cfg.wisp.enable || cfg.wisp.url != null || cfg.publicUrl != null;
        message = "services.unkernel.publicUrl or services.unkernel.wisp.url is required when Wisp hosting is enabled";
      }
    ];

    networking.firewall.allowedTCPPorts = optional cfg.openFirewall cfg.port;

    systemd.services.unkernel-web = {
      description = "unkernel web application";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        HOST = "127.0.0.1";
        PORT = toString cfg.runtimePort;
        NITRO_HOST = "127.0.0.1";
        NITRO_PORT = toString cfg.runtimePort;
      };
      serviceConfig = {
        ExecStart = "${pkgs.nodejs_24}/bin/node ${web}/server/index.mjs";
        WorkingDirectory = web;
        Restart = "on-failure";
        DynamicUser = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
      };
    };

    systemd.services.unkernel-wisp = mkIf cfg.wisp.enable {
      description = "unkernel Wisp network proxy";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = "${cfg.wisp.package}/bin/epoxy-server --format json ${wispConfig}";
        Restart = "on-failure";
        DynamicUser = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
      };
    };

    services.nginx = {
      enable = true;
      recommendedProxySettings = true;
      virtualHosts."unkernel" = {
        listen = [
          {
            addr = cfg.listenAddress;
            inherit (cfg) port;
          }
        ];
        extraConfig = ''
          absolute_redirect off;
          ${isolationHeaders}
        '';
        locations = {
          "/" = {
            proxyPass = "http://127.0.0.1:${toString cfg.runtimePort}";
            extraConfig = ''
              proxy_hide_header Cross-Origin-Opener-Policy;
              proxy_hide_header Cross-Origin-Embedder-Policy;
              proxy_hide_header Cross-Origin-Resource-Policy;
            '';
          };
        }
        // instanceLocations
        // lib.optionalAttrs cfg.cache.enable {
          "/cache/" = {
            proxyPass = "http://127.0.0.1:${toString cfg.cache.port}/";
          };
        }
        // lib.optionalAttrs cfg.wisp.enable {
          "/wisp/" = {
            proxyPass = "http://127.0.0.1:${toString cfg.wisp.port}/";
            proxyWebsockets = true;
            extraConfig = ''
              proxy_read_timeout 1d;
              proxy_send_timeout 1d;
            '';
          };
        };
      };
    };

    services.nix-serve = mkIf cfg.cache.enable {
      enable = true;
      bindAddress = "127.0.0.1";
      inherit (cfg.cache) port;
      secretKeyFile = cfg.cache.secretKeyFile;
    };
  };
}
