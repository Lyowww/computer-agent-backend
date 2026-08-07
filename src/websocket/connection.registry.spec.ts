import { ConnectionRegistry } from './connection.registry';
import { Socket, Server } from 'socket.io';

describe('ConnectionRegistry', () => {
  it('routes messages to device and user rooms', () => {
    const registry = new ConnectionRegistry();
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    registry.setServer({ to } as unknown as Server);

    const join = jest.fn();
    const socket = { id: 's1', join } as unknown as Socket;

    registry.register(socket, {
      channel: 'desktop-agent',
      userId: 'u1',
      deviceId: 'd1',
    });

    expect(registry.isDeviceOnline('d1')).toBe(true);
    expect(registry.sendToDevice('d1', 'CAPTURE_SCREEN', { requestId: 'r1' })).toBe(
      true,
    );
    expect(to).toHaveBeenCalledWith('device:d1');
    expect(registry.sendToUser('u1', 'TASK_UPDATE', { taskId: 't1' })).toBe(true);

    registry.unregister('s1');
    expect(registry.isDeviceOnline('d1')).toBe(false);
    expect(registry.sendToDevice('d1', 'X', {})).toBe(false);
  });
});
