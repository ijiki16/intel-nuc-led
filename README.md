# Intel NUC LED Control: NUC6CAY, NUC7i[x]BN and NUC10i3FNH, maybe more

This is a simple kernel module to control LEDs on Intel NUCs, with
optional high-level userspace tools.

It is based on the previous work at
[github.com/milesp20/intel_nuc_led](https://github.com/milesp20/intel_nuc_led/), but
with significant changes:

* it can be used with the more recent NUC10 as well
* it tracks the more recent kernel APIs
* the kernel API is very low-level, and you'll be sending and receiving bytes
* higher-level commands like "turn the power LED to flashing red" are not
  implemented in the kernel module itself, but in user space.

This was primarily created for [UBOS](https://ubos.net/), a Linux distro for
self-hosting (based on Arch) and is mostly tested there. But chances are you
can run it on other distros as well.

Pull requests appreciated. And reports if you could (or could not) get it
running on other NUCs with software-controllable LEDs, and other distros.

### What this fork adds

* `install-fedora.sh`: one-command DKMS install for Fedora that loads the
  module at boot and lets your user control the LEDs without root
* a GNOME Shell extension to control the LEDs from the top bar
* driver fixes: no kernel crash when the WMI call returns nothing, and no
  memory leak on invalid input
* explicit build commands in `dkms.conf`

## Fedora quick install + GNOME extension (this fork)

Tested on a NUC7i5BNB (BIOS BN0063) with Fedora 44 (kernel 7.2) and GNOME 50.

1. In the BIOS (F2 → Advanced → Power → Secondary Power Settings), set
   **Ring LED** and **Button LED** to **SW control**. Without this, every
   call returns `e2` (undefined device).
2. Build, install with DKMS and load at every boot (your user becomes owner of
   `/proc/acpi/nuc_led`, so no root is needed afterwards):

   ```
   sudo ./install-fedora.sh
   ```

3. Install the GNOME Shell extension (GNOME 48–50), then log out and back in:

   ```
   ln -s "$PWD/gnome-extension/nuc-led@applecross" ~/.local/share/gnome-shell/extensions/
   gnome-extensions enable nuc-led@applecross
   ```

   A ring icon appears in the top bar, tinted with the ring LED's color. Its
   menu has an on/off switch, a brightness slider, and color and effect
   pickers for the ring LED and the power button LED. The menu reads the
   current LED state each time it opens, and shows a warning line if the
   module is not loaded or a call fails.

   The extension uses the NUC6CAY / NUC7i[x]BN commands (method IDs 1 and 2).
   It does not support the NUC10, which uses a different API.

Quick command-line test (NUC6CAY / NUC7i[x]BN):

```
echo "02 02 64 04 06" > /proc/acpi/nuc_led   # ring: 100%, solid, green
cat /proc/acpi/nuc_led                        # 00 00 00 00 = no error
```

The DKMS module is rebuilt automatically after kernel updates. After
changing the driver source, run `sudo ./install-fedora.sh` again to install
the new build.

### Uninstall

```
gnome-extensions disable nuc-led@applecross
rm ~/.local/share/gnome-shell/extensions/nuc-led@applecross
sudo rmmod nuc_led
sudo dkms remove -m intel-nuc-led -v 1.0 --all
sudo rm -rf /usr/src/intel-nuc-led-1.0 /etc/modules-load.d/nuc_led.conf /etc/modprobe.d/nuc_led.conf
```

### Troubleshooting

* **Every call returns `e2 00 00 00`:** the LED is not set to SW control in
  the BIOS (see step 1).
* **`/proc/acpi/nuc_led` does not exist:** the module is not loaded. Check
  `lsmod | grep nuc_led` and `journalctl -k | grep -i nuc`. The module
  refuses to load if the NUC's LED WMI interface
  (`8C5DA44C-CDC3-46B3-8619-4E26D34390B7`) is missing from
  `/sys/bus/wmi/devices/`.
* **Module won't load with Secure Boot on:** the module is unsigned. Either
  disable Secure Boot or sign it with a key enrolled through `mokutil`.
* **Permission denied writing `/proc/acpi/nuc_led`:** the file is owned by
  root. Run the install script with `sudo` from your own account, or set
  `options nuc_led nuc_led_uid=<your uid>` in `/etc/modprobe.d/nuc_led.conf`.
* **Extension doesn't show up:** on Wayland, GNOME only finds new or changed
  extensions after you log out and back in.

## Requirements

Requirements:

* Intel NUC6CAY, or NUC7i[x]BN or NUC10i3FNH, maybe more
* BIOS AY0038 or BN0043 or later
* ACPI/WMI support in kernel
* LED(s) set to `SW Control` in BIOS for those (older) NUCs where this can
  only be changed in the BIOS, not via API.

## Building the kernel module

The `nuc_led` kernel module supports building and installing "from source" directly or using `dkms`.

### Installing Build Dependencies

UBOS: you don't need to, it's in the repos: ``pacman -S intel-nuc-led``

If you want to build it anyway, you need:

```
pacman -S linux-headers base-devel
```

Ubuntu (not verified):

```
apt-get install build-essential linux-headers-$(uname -r)

# DKMS dependencies
apt-get install debhelper dkms
```

Fedora (verified on Fedora 44):

```
dnf install gcc make kernel-devel-$(uname -r) dkms
```

Redhat (not verified):

```
yum groupinstall "Development Tools"
yum install kernel-devel-$(uname -r)

# Install appropriate EPEL for DKMS if needed by your RHEL variant
yum install https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm

yum install dkms
```

### Building and Installing "from source"

```
make clean
make install
```

### Building and Installing Using DKMS

Build and install without system packaging:

```
make dkms-install
```

Uninstall without system packaging:

```
make dkms-uninstall
```

Build and install using system packaging:

```
# UBOS
makepkg -i

# Ubuntu (not verified)
make dkms-deb

# RHEL (not verified)
make dkms-rpm

# Install generated DEB/RPM from the folder specified in the output using system package manager
```

## Low-level vs high-level interface

In the previous, NUC6/NUC7-only version by milesp20, you would use something like:

```
echo 'ring,80,blink_medium,green' > /proc/acpi/nuc_led
```

to turn the ring LED to a blinking green. But with the greater hardware
variety now supported by this module, and a substantially extended number
of API calls, this interface doesn't make so much sense any more. In
addition, some settings now require several system calls.

So instead, the kernel module now simply exposes the input and outputs of
the WMI system call, and leaves it to userspace to send in the right bytes,
and interpret the resulting bytes.

~~Maybe somebody wants to design some higher-level tools to make this easier?
As a bonus, those tools could run in userspace.~~
Thanks to [Julio Lajara](https://github.com/ju2wheels), who built exactly
that. See documentation in [contrib/nuc_wmi](contrib/nuc_wmi).

## Usage (Kernel device)

NOTE: this works differently from the previous version by milesp20.

```
echo xx xx xx xx xx > /proc/acpi/nuc_led
```
where the ``xx`` are 1-byte hex numbers:

* first byte: the Method ID of the WMI call
* bytes 2-5: the four bytes of arguments passed into the WMI call

This will invoke the specified method with the provided arguments,
and save the return results.

And then:

```
cat /proc/acpi/nuc_led
```
will emit 4 hex numbers, which are the bytes returned by the last
invocation of the WMI system call.

## The bytes and their values

The following Intel documents describe the available Method IDs and
parameters:

* for the NUC6CAY, or NUC7i[x]BN:
  [Use WMI Explorer* to Program the Ring LED and Button LED](https://www.intel.com/content/www/us/en/support/articles/000023426/intel-nuc/intel-nuc-kits.html).

* for the NUC10i3FNH:
  [WMI Interface for Intel NUC Products / WMI Specification / Frost Canyon / July2020 Revision 1.0](https://www.intel.com/content/dam/support/us/en/documents/intel-nuc/WMI-Spec-Intel-NUC-NUC10ixFNx.pdf)

There are copies of these documents here in [contrib/reference](contrib/reference/).

Note that the WMI APIs have changed significantly. E.g. the Method IDs
for the older models are 1 and 2, while they are 3 to 9 for the newer
model.

## Errors

Errors will appear as warnings in dmesg or journalctl -k. WMI call
error codes are part of the return value of the WMI call, and shown
through ``cat /proc/acpi/nuc_led``.

On the NUC6CAY and NUC7i[x]BN, the first returned byte is the error code
(for "set" calls, the first three bytes are the error codes for brightness,
blinking and color):

| Code | Meaning |
|------|---------|
| `00` | No error |
| `e1` | Function not supported |
| `e2` | Undefined device (usually: LED not set to SW control in BIOS) |
| `e3` | Embedded controller does not respond |
| `e4` | Invalid parameter |
| `ef` | Unexpected error |

Once the device has been read, the value there will be reset to
``ff ff ff ff`` (something not used by the WMI call). This is also the
initial value.

## Examples

### NUC6CAY and NUC7i[x]BN

Make sure you have enabled LED software control in the BIOS, as there
is no API call to change that setting on these devices.

Commands:

```
echo 01 <led> 00 00 00 > /proc/acpi/nuc_led                    # get state
echo 02 <led> <brightness> <effect> <color> > /proc/acpi/nuc_led   # set state
```

A "get" returns `<error> <brightness> <effect> <color>`.

| Byte | Values |
|------|--------|
| led | `01` power button, `02` ring |
| brightness | `00` (0%) to `64` (100%), in hex |
| effect | `04` solid; blink: `01` 1 Hz, `05` 0.5 Hz, `02` 0.25 Hz; fade: `03` 1 Hz, `07` 0.5 Hz, `06` 0.25 Hz |
| power button color | `00` off, `01` blue, `02` amber |
| ring color | `00` off, `01` cyan, `02` pink, `03` yellow, `04` blue, `05` red, `06` green, `07` white |

Effects `05`–`07` need BIOS AY0038 / BN0043 or later.

To set the Ring LED to brightness 80, blink at medium speed, and green:

```
echo 02 02 50 05 06 > /proc/acpi/nuc_led
```

where:
* `02`: method ID: "Set LED function"
* `02`: Ring LED command mode
* `50`: 80% brightness (in hex)
* `05`: 0.5 Hz
* `06`: green

### NUC10i3FNH

Make sure you have enabled LED software control in the BIOS, or have
previously executed the API call to turn on software control.

To set the Power Button LED to brightness 80, blink at medium speed, and color amber:

```
echo 06 00 04 00 50 > /proc/acpi/nuc_led # brightness
echo 06 00 04 01 02 > /proc/acpi/nuc_led # blinking behavior
echo 06 00 04 02 05 > /proc/acpi/nuc_led # blinking frequency
echo 06 00 04 03 01 > /proc/acpi/nuc_led # color

```

where:

* brightness:

  * `06`: method ID: "Set the value to the control item of the indicator option and the LED type"
  * `00`: power button LED
  * `04`: software indicator
  * `00`: brightness control item
  * `50`: brightness value (in hex)

* blinking behavior (same, then):

  * `01`: blinking behavior control item
  * `02`: pulsing

* blinking frequency (same, then):

  * `02`: blinking behavior control item
  * `05`: 5 times 0.1Hz = 0.5Hz

* color (same, then):

  * `03`: color control item
  * `01`: amber color

## Permissions

You can change the owner, group and permissions of `/proc/acpi/nuc_led` by
passing parameters to the kernel module. Use:

* `nuc_led_uid` to set the owner (default is 0, root)
* `nuc_led_gid` to set the owning group (default is 0, root)
* `nuc_led_perms` to set the file permissions (default is r+w for
  group and user and r for others)

Note: Once an LED has been set to `SW Control` in the BIOS, it will
remain off initially until a color is explicitly set, after which the set
color is retained across reboots.
