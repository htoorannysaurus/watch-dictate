#!/usr/bin/env python3
"""Resolve a physical watch's Xcode UDID and CoreDevice ID without signing."""
import json
import re
import sys


def select_watch(devices, destinations, requested):
    watches = [d for d in devices if d.get('hardwareProperties', {}).get('platform') == 'watchOS'
               and d.get('hardwareProperties', {}).get('reality') != 'simulated']
    matches = [d for d in watches if not requested or requested in
               (d.get('identifier'), d.get('hardwareProperties', {}).get('udid'))]
    if len(matches) != 1:
        raise ValueError('DEVICE_ID must identify exactly one physical watch from devicectl list devices.')
    device = matches[0]
    udid = device['hardwareProperties']['udid']
    entries = re.findall(r'\{([^{}]+)\}', destinations)
    for entry in entries:
        fields = dict(re.findall(r'(?:^|,)\s*(\w+):([^,}]+)', entry))
        fields = {k: v.strip() for k, v in fields.items()}
        if fields.get('platform') == 'watchOS' and fields.get('id') == udid:
            if 'error' in fields:
                raise ValueError('Xcode cannot use this watch: ' + fields['error'])
            return udid, device['identifier']
    raise ValueError('This watch is not an available Xcode watchOS destination. Check pairing, OS, and Developer Mode in Xcode.')


if __name__ == '__main__':
    try:
        with open(sys.argv[1]) as source:
            devices = json.load(source)['result']['devices']
        with open(sys.argv[2]) as source:
            destinations = source.read()
        print(*select_watch(devices, destinations, sys.argv[3]), sep='\n')
    except (ValueError, KeyError) as error:
        sys.exit(str(error))
