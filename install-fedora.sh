#!/bin/bash
# Install nuc_led via DKMS (rebuilt on kernel updates) and load it at boot.
# Usage: sudo ./install-fedora.sh
# The user who runs sudo becomes owner of /proc/acpi/nuc_led, so they can
# control the LEDs without root.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo: sudo $0" >&2
    exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VER=1.0
LED_UID="${SUDO_UID:-0}"

dnf install -y dkms gcc make "kernel-devel-$(uname -r)"

# Copy source to /usr/src and build for the running kernel
rm -rf "/usr/src/intel-nuc-led-$VER"
mkdir -p "/usr/src/intel-nuc-led-$VER"
cp "$SRC"/{nuc_led.c,Makefile,dkms.conf} "/usr/src/intel-nuc-led-$VER/"
dkms remove -m intel-nuc-led -v "$VER" --all 2>/dev/null || true
dkms install -m intel-nuc-led -v "$VER"

# Load at boot
echo nuc_led > /etc/modules-load.d/nuc_led.conf
echo "options nuc_led nuc_led_uid=$LED_UID" > /etc/modprobe.d/nuc_led.conf

# Reload so the new build and options take effect now
rmmod nuc_led 2>/dev/null || true
modprobe nuc_led
ls -l /proc/acpi/nuc_led
dkms status intel-nuc-led
echo "Done."
