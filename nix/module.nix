# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Rafiq bin Mohamad
{ self }:
{
  config,
  lib,
  ...
}:
let
  inherit (lib)
    filterAttrs
    mapAttrs'
    mkEnableOption
    mkIf
    mkOption
    nameValuePair
    types
    ;
  cfg = config.services.unkernel;
  enabledInstances = filterAttrs (_: instance: instance.enable) cfg.instances;
  seedEtcFiles = mapAttrs' (
    name: instance:
    let
      guest = self.lib.mkGuest {
        inherit (instance) additionalSpace configuration;
        diskSize = if instance.diskSize == null then "auto" else instance.diskSize;
      };
    in
    nameValuePair "unkernel/${name}/${instance.seedName}.img" {
      source = "${guest.image}/unkernel-nixos.img";
    }
  ) enabledInstances;
in
{
  options.services.unkernel = {
    enable = mkEnableOption "unkernel browser guests";

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
                description = "Stable browser disk identity. Changing it creates a new machine.";
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
    ];

    environment.etc = seedEtcFiles;
  };
}
