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
  boot.modprobeConfig.enable = false;

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

  # unkernel intentionally omits several physical-kernel sysctls. systemd-sysctl
  # reports those missing paths with exit status 1, which must not make a live
  # NixOS generation switch fail after the supported settings were applied.
  systemd.services.systemd-sysctl.serviceConfig.SuccessExitStatus = [ 1 ];

  systemd.services.unkernel-current-system = {
    description = "Restore the active NixOS system links";
    wantedBy = [ "sysinit.target" ];
    before = [
      "sysinit.target"
      "systemd-tmpfiles-setup.service"
    ];
    unitConfig.DefaultDependencies = false;
    serviceConfig.Type = "oneshot";
    script = ''
      activeSystem="$(${pkgs.coreutils}/bin/readlink -f /nix/var/nix/profiles/system)"
      ${pkgs.coreutils}/bin/ln -sfn "$activeSystem" /run/current-system
      ${pkgs.coreutils}/bin/ln -sfn "$activeSystem" /run/booted-system
    '';
  };

  users.users.root = {
    initialHashedPassword = "";
    shell = pkgs.bashInteractive;
  };

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
