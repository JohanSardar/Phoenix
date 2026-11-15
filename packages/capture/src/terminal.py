import json
import os
import selectors
import signal
import struct
import subprocess
import sys
import termios
import fcntl

sizes = json.loads(sys.argv[1])
masters = {}
slaves = []
fds = []
for fd, name in enumerate(("stdin", "stdout", "stderr")):
    size = sizes[name]
    if size:
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", size["rows"], size["columns"], 0, 0))
        masters[fd] = master
        slaves.append(slave)
        fds.append(slave)
    else:
        fds.append(fd)
child = subprocess.Popen(sys.argv[2:], stdin=fds[0], stdout=fds[1], stderr=fds[2])
for fd in slaves:
    os.close(fd)
selector = selectors.DefaultSelector()
selector.register(3, selectors.EVENT_READ, "control")
if 0 in masters:
    selector.register(0, selectors.EVENT_READ, "input")
for fd, master in masters.items():
    if fd != 0:
        selector.register(master, selectors.EVENT_READ, fd)
controls = b""
while child.poll() is None or any(isinstance(key.data, int) for key in selector.get_map().values()):
    for key, _ in selector.select(0.05):
        try:
            data = os.read(key.fd, 65536)
        except OSError:
            data = b""
        if not data:
            selector.unregister(key.fd)
            continue
        if key.data == "input":
            os.write(masters[0], data)
        elif key.data == "control":
            controls += data
            while b"\n" in controls:
                line, controls = controls.split(b"\n", 1)
                control = json.loads(line)
                if control["type"] == "signal":
                    child.send_signal(getattr(signal, control["signal"]))
                elif control["type"] == "resize":
                    fd = masters.get(control["fd"])
                    if fd is not None:
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", control["rows"], control["columns"], 0, 0))
                        child.send_signal(signal.SIGWINCH)
        else:
            view = memoryview(data)
            while view:
                view = view[os.write(key.data, view):]
code = child.wait()
if code < 0:
    signal.signal(-code, signal.SIG_DFL)
    os.kill(os.getpid(), -code)
sys.exit(code)
