# cp2 bridge

Companion to **cp2**. It runs on the machine where your browser is (VS Code's local extension host), even when your
workspace lives in WSL, on an SSH machine or in a container, and owns `ws://127.0.0.1:27122` for the cp2 browser
extension. cp2 talks to it through VS Code itself, so no ports need forwarding.

With several VS Code windows open, the first one owns the port and the others relay through it; imports triggered
from the browser's toolbar icon go to the window you used last.

`cp2 bridge: Show Status` tells you whether the browser is connected.
