import { ConnectionRegistry } from './connection.registry';
import { Socket, Server } from 'socket.io';

describe('ConnectionRegistry', () => {
  it('routes messages to device and user rooms', async () => {
    const registry = new ConnectionRegistry();
    const roomEmit = jest.fn();
    const to = jest.fn(() => ({ emit: roomEmit }));
    registry.setServer({ to } as unknown as Server);

    const socketEmit = jest.fn();
    const join = jest.fn().mockResolvedValue(undefined);
    const socket = {
      id: 's1',
      join,
      connected: true,
      emit: socketEmit,
    } as unknown as Socket;

    await registry.register(socket, {
      channel: 'desktop-agent',
      userId: 'u1',
      deviceId: 'd1',
    });

    expect(registry.isDeviceOnline('d1')).toBe(true);
    expect(registry.sendToDevice('d1', 'CAPTURE_SCREEN', { requestId: 'r1' })).toBe(
      true,
    );
    expect(socketEmit).toHaveBeenCalledWith('CAPTURE_SCREEN', { requestId: 'r1' });
    expect(to).toHaveBeenCalledWith('device:d1');
    expect(registry.sendToUser('u1', 'TASK_UPDATE', { taskId: 't1' })).toBe(true);

    registry.unregister('s1');
    expect(registry.isDeviceOnline('d1')).toBe(false);
    expect(registry.sendToDevice('d1', 'X', {})).toBe(false);
  });

  it('returns false when device sockets are registered but disconnected', async () => {
    const registry = new ConnectionRegistry();
    registry.setServer({ to: jest.fn(() => ({ emit: jest.fn() })) } as unknown as Server);

    const socket = {
      id: 's1',
      join: jest.fn().mockResolvedValue(undefined),
      connected: false,
      emit: jest.fn(),
    } as unknown as Socket;

    await registry.register(socket, {
      channel: 'desktop-agent',
      userId: 'u1',
      deviceId: 'd1',
    });

    // Stale registry entry: id map still has the socket, but connected=false.
    expect(registry.isDeviceOnline('d1')).toBe(false);
    expect(registry.sendToDevice('d1', 'NOTIFY', { requestId: 'r1', body: 'hi' })).toBe(
      false,
    );
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
