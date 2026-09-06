import minescript
import time
import math

yaw, start_pitch = minescript.player_orientation()
target_pitch = -90

duration = 1.0
steps = 250

for i in range(steps + 1):
    t = i / steps

    # Sine-shaped interpolation: 0 → 1
    y = (1 - math.cos(math.pi * t)) / 2

    pitch = start_pitch + (target_pitch - start_pitch) * y

    minescript.player_set_orientation(yaw, pitch)
    time.sleep(duration / steps)


time.sleep(0.25)
minescript.player_press_sneak(True)
time.sleep(0.4)
minescript.player_press_attack(True)
time.sleep(0.5)
minescript.player_press_use(True)



while True:
    time.sleep(0.1)
