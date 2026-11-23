# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Rafiq bin Mohamad
{
  lib,
  pkgs,
  ...
}:
{
  boot.loader.grub.enable = false;
  boot.loader.systemd-boot.enable = false;

  fileSystems."/" = {
    device = "/dev/wda";
    fsType = "ext4";
  };

  networking = {
    firewall.enable = false;
    hostName = "unkernel";
    useDHCP = false;
    useNetworkd = true;
  };

  systemd.network = {
    enable = true;
    networks."10-eth0" = {
      matchConfig.Name = "eth0";
      networkConfig.DHCP = "yes";
    };
  };

  services.getty.autologinUser = lib.mkDefault "root";

  users.users.root.initialHashedPassword = "";

  environment.systemPackages = with pkgs; [
    fish
    git
    neovim
    ripgrep
  ];

  programs.fish.enable = true;

  nix = {
    channel.enable = false;
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      sandbox = false;
    };
  };

  documentation.enable = false;
  security.sudo.enable = false;

  system.stateVersion = "26.05";
}
