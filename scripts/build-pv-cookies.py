"""Build a clean Netscape cookies.txt + Cookie header from the user's pasted
primevideo.com cookies (their own session, for testing their own tool).

Outputs:
  /home/z/my-project/download/pv-cookies.txt   (Netscape format, tabs)
  /tmp/pv-header.txt                           (name=value; name2=value2 header)
"""

PAIRS = [
    ("at-main-av", "Atza|gQBD2xUiAwEBAhT-_MxPWKXwww6KnSBv-3WaFTHm523su5ALuXnmkjq0H0uBVJ-8IdBMqmYjzoE4ijj6slqXbuSMc4COhF8ZRQpM8HW5I7lkshnJJFzvVe4aSxA26WbqAh5TbiMMdxfjregC974phYmceGHiJE2gaKfAIuabmHeKklqJaicirxoAwnk_DTK4OJ62g_s0t2yxPWaVP9OPwklxkOrsd5AE8BIGEUbvwvMxNjM01lY9QbdpELAhL3NoRIAPyBBEN3P-dXaJthvmY3IR6viz8j0WOnD2WxCYZZmMmR_pUomMG1DkfFsMpZJjo0A84DhCiYYsNVmm1Zsc-VMisJP7wRwPm463PPntvO3-uxx_UhD2Qj5njWkqz7MizxcoS-niWWCMQEx-od5ljw1_"),
    ("i18n-prefs", "USD"),
    ("lc-main-av", "fr_FR"),
    ("sess-at-main-av", "riLxlzE8cXMtCP3eYt6lDD0rfLKT+ooR1zZ0sNwsqEM="),
    ("session-id-time", "2082787201l"),
    ("ubid-main-av", "261-2678462-9887354"),
    ("sst-main-av", "Sst1|PQJEqp_0MBL9XRqKQfsG7JbHB6GAWtsdvloSaXu3U7XKn2CKCWLAD-X2thROFI1IDqW_CKoR2RpSTnyZYEviMC5d2CVccSMZOJJsyxfh0Njzh0mewdfT9SV_n8znrpIjp1BKZneDDI3RKdUi0z19rENkNK47tDhXcCQGPaQApdlYeDrU-4ZtfDsd7KHSQE108AvZ2FilPD6CMxzzU4o1YW81kvNYd4ZgqEym5WGXk7Lz3HR-m-RER4gb7sdf_q5RCRia"),
    ("av-timezone", "Europe/Paris"),
    ("av-profile", "cGlkPWFtem4xLmFjdG9yLnBlcnNvbi5vaWQuQTNVVUs3QzcxT0lBWDAmdGltZXN0YW1wPTE3ODIxMTM0NTQxNTUmdmVyc2lvbj12MQ.g5rVVuXvfe1O8pozLRu92l7p9gY2Wrl4hs8tGYuGjegjAAAAAQAAAABqOOSucmF3AAAAAPgWC9WfHH8iB-olH_E9xQ"),
    ("csm-hit", "tb:W0QVSBXHNQ3TWM3YWD54+s-N0R1TT32DNFQJKSX5Q13|1781552074480&t:1782113455794&adb:adblk_no"),
    ("session-id", "262-2437939-5082132"),
    ("session-token", "\"5wsOv67txyk3THDAeKDX/tdDC0XlNkl/r/WIjXXdR1lMlZtjeafJFB/m9y2L7Hdh89LPiVBGN+pXsm32CcZfcBJ4JcMcL29cI2kEgFSALATx2EBY2kIHBL5HTsAvebgHlURXGtlz4NAatHyeL43vsyXH0ltg64lBu5+3lHQI+oxqxVlLxsSnbDvhR3EbFQM+pSmLlZ3LgPRIl/kWoX+98eahqK9rdffRMs1V5MByJcYKqMydSVox81NHQL0Bu+VKST9V6oZNnIw=\""),
    ("x-main-av", "\"fWQKWW?rRqwCNC4Hpcm6KUQGLOI3dCAtACKK6e0LY47B0jBerfbAcedBJU?vjwOu\""),
]

DOMAIN = "www.primevideo.com"
EXPIRES = "1824208189"

out = ["# Netscape HTTP Cookie File", "# reconstructed from user paste for LoginProbe testing"]
for name, value in PAIRS:
    out.append(f"{DOMAIN}\tFALSE\t/\tTRUE\t{EXPIRES}\t{name}\t{value}")

txt_path = "/home/z/my-project/download/pv-cookies.txt"
with open(txt_path, "w") as f:
    f.write("\n".join(out) + "\n")

header = "; ".join(f"{n}={v}" for n, v in PAIRS)
with open("/tmp/pv-header.txt", "w") as f:
    f.write(header)

print(f"wrote {txt_path} ({len(PAIRS)} cookies)")
print("header bytes:", len(header))
