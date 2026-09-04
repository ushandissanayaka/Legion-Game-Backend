import { Server, Socket } from 'socket.io';
import { GameManager } from '../game/GameManager';
import { PlayerManager } from '../players/PlayerManager';
import {
  SOCKET_EVENTS,
  PLAYER_HITBOX_RADIUS,
  GameStateEnum,
} from '../types/game';

// Simple 3D vector helper
function vec3Length(v: { x: number; y: number; z: number }): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vec3Dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// Ray-sphere intersection for basic server-side shot validation
function raySphereDistance(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  sphereCenter: { x: number; y: number; z: number },
  radius: number
): number | null {
  const oc = { x: origin.x - sphereCenter.x, y: origin.y - sphereCenter.y, z: origin.z - sphereCenter.z };
  const a = vec3Dot(dir, dir);
  if (a === 0) return null;
  const b = 2.0 * vec3Dot(oc, dir);
  const c = vec3Dot(oc, oc) - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2.0 * a);
  return t >= 0 && t <= 150 ? t : null; // max shoot distance
}

export function registerSocketHandlers(
  io: Server,
  socket: Socket,
  gameManager: GameManager,
  playerManager: PlayerManager
): void {

  // ──────────────────────────────────────────────────────────
  // CREATE ROOM
  // ──────────────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.CREATE_ROOM, (payload: { playerName: string; matchDuration?: number }) => {
    try {
      const { playerName, matchDuration } = payload;
      if (!playerName?.trim()) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Player name required', code: 'INVALID_NAME' });
        return;
      }

      const room = gameManager.createRoom(socket.id, matchDuration);
      const player = playerManager.createPlayer(socket.id, playerName, room.id, 0, true);
      room.addPlayer(player);
      socket.join(room.id);

      socket.emit(SOCKET_EVENTS.ROOM_CREATED, {
        roomId: room.id,
        player,
        room: room.getRoomState(),
      });

      console.log(`[Room] ${playerName} created room ${room.id}`);
    } catch (err) {
      console.error('createRoom error:', err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: 'Failed to create room', code: 'SERVER_ERROR' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // JOIN ROOM
  // ──────────────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.JOIN_ROOM, (payload: { roomId: string; playerName: string }) => {
    try {
      const { roomId, playerName } = payload;
      const upperRoomId = roomId?.toUpperCase().trim();

      if (!playerName?.trim()) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Player name required', code: 'INVALID_NAME' });
        return;
      }

      const check = gameManager.canJoinRoom(upperRoomId);
      if (!check.ok) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: check.reason || 'Cannot join', code: 'JOIN_FAILED' });
        return;
      }

      const room = gameManager.getRoom(upperRoomId)!;
      const spawnIndex = room.playerCount;
      const player = playerManager.createPlayer(socket.id, playerName, upperRoomId, spawnIndex, false);
      room.addPlayer(player);
      socket.join(upperRoomId);

      // Tell the joining player their info
      socket.emit(SOCKET_EVENTS.ROOM_JOINED, { player, room: room.getRoomState() });

      // Tell everyone else a new player joined
      socket.to(upperRoomId).emit(SOCKET_EVENTS.PLAYER_JOINED, {
        player,
        room: room.getRoomState(),
      });

      console.log(`[Room] ${playerName} joined room ${upperRoomId} (${room.playerCount} players)`);
    } catch (err) {
      console.error('joinRoom error:', err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: 'Failed to join room', code: 'SERVER_ERROR' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // LEAVE ROOM
  // ──────────────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.LEAVE_ROOM, (payload: { roomId: string }) => {
    handlePlayerLeave(socket.id, payload?.roomId, io, gameManager, playerManager);
    socket.leave(payload?.roomId);
  });

  // ──────────────────────────────────────────────────────────
  // DISCONNECT
  // ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = playerManager.getPlayer(socket.id);
    if (player) {
      handlePlayerLeave(socket.id, player.roomId, io, gameManager, playerManager);
    }
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });

  // ──────────────────────────────────────────────────────────
  // PLAYER MOVE (position sync)
  // ──────────────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.PLAYER_MOVE, (payload: {
    roomId: string;
    position: { x: number; y: number; z: number };
    rotation: { yaw: number; pitch: number };
  }) => {
    const { roomId, position, rotation } = payload;
    const room = gameManager.getRoom(roomId);
    const player = playerManager.getPlayer(socket.id);
    if (!room || !player || player.roomId !== roomId || !room.players.has(socket.id)) return;

    if (!position || !rotation || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)
      || !Number.isFinite(rotation.yaw) || !Number.isFinite(rotation.pitch)) return;

    const accepted = playerManager.updatePosition(socket.id, position, rotation);
    if (!accepted) return;

    // Broadcast to others in room (not sender)
    socket.to(roomId).emit(SOCKET_EVENTS.PLAYER_POSITION, {
      playerId: socket.id,
      position: player.position,
      rotation: player.rotation,
    });
  });

  // ──────────────────────────────────────────────────────────
  // PLAYER SHOOT
  // ──────────────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.PLAYER_SHOOT, (payload: {
    roomId: string;
    targetId?: string | null;
    playerId?: string;
    targetPlayerId?: string;
    victimId?: string;
    hitPlayerId?: string;
    hitTargetId?: string;
    target?: string | { id?: string } | null;
    origin?: { x: number; y: number; z: number };
    direction?: { x: number; y: number; z: number };
    weaponType?: string;
    damage?: number;
    timestamp?: number;
  }) => {
    try {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId.toUpperCase().trim() : '';
      const origin = payload?.origin;
      const direction = payload?.direction;
      // Different client builds have used different target field names.  Prefer
      // the explicit target fields; `playerId` is retained only for older
      // clients that used it to mean the player that was hit.
      const targetFromObject = typeof payload.target === 'object' ? payload.target?.id : payload.target;
      const targetCandidates = [
        payload.targetId,
        payload.targetPlayerId,
        payload.victimId,
        payload.hitPlayerId,
        payload.hitTargetId,
        targetFromObject,
        payload.playerId,
      ];
      const requestedTargetId = targetCandidates.find((id): id is string =>
        typeof id === 'string' && id.length > 0 && id !== socket.id
      ) ?? null;

      // Validate and clamp damage per weapon type (server-authoritative)
      const WEAPON_MAX: Record<string, number> = {
        assault: 25,
        shotgun: 18,  // per pellet, 8 pellets = 144 max but single pellet validated
        sniper: 100,
      };
      const claimedDamage = typeof payload.damage === 'number' && Number.isFinite(payload.damage)
        ? payload.damage
        : 25;
      const weaponKey = payload.weaponType && WEAPON_MAX[payload.weaponType] ? payload.weaponType : 'assault';
      const validatedDamage = Math.max(1, Math.min(claimedDamage, WEAPON_MAX[weaponKey]));
      const room = gameManager.getRoom(roomId);
      if (!room || room.gameState !== GameStateEnum.PLAYING) return;

      const shooter = playerManager.getPlayer(socket.id);
      if (!shooter || shooter.roomId !== roomId || !room.players.has(socket.id) || !shooter.alive) return;

      // A shot timestamp is useful for diagnostics, but must not decide whether
      // a hit counts. Network delay regularly exceeds a small fixed tolerance,
      // and some clients use a monotonic (non-epoch) clock. The server already
      // validates the shooter, room, target and damage below.
      const now = Date.now();
      const shotTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : now;
      if (!Number.isFinite(shotTimestamp) || shotTimestamp > now + 30_000) return;

      // Don't shoot yourself
      let resolvedTargetId = requestedTargetId;
      let target = resolvedTargetId ? playerManager.getPlayer(resolvedTargetId) : undefined;

      // Resolve hits server-side when the client does not provide a target id.
      if (!target || !target.alive || target.roomId !== roomId) {
        if (!origin || !direction) return;
        const directionLength = vec3Length(direction);
        if (!origin || !direction || ![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite)
          || directionLength === 0) return;

        const normalizedDir = {
          x: direction.x / directionLength,
          y: direction.y / directionLength,
          z: direction.z / directionLength,
        };
        let nearestDistance = Infinity;
        for (const candidate of room.players.values()) {
          if (candidate.id === socket.id || !candidate.alive) continue;
          const distance = raySphereDistance(
            origin,
            normalizedDir,
            { x: candidate.position.x, y: candidate.position.y + 1, z: candidate.position.z },
            PLAYER_HITBOX_RADIUS * 2.5
          );
          if (distance !== null && distance < nearestDistance) {
            nearestDistance = distance;
            resolvedTargetId = candidate.id;
            target = candidate;
          }
        }
      }

      if (!resolvedTargetId || !target || !target.alive || target.roomId !== roomId) return;
      const finalTargetId = resolvedTargetId;
      if (!target || !target.alive || target.roomId !== roomId) return;

      // Apply damage (server-validated amount)
      const { newHealth, died } = playerManager.applyDamage(finalTargetId, validatedDamage);
      const targetPlayer = playerManager.getPlayer(finalTargetId);
      if (!targetPlayer) return;

      console.log(`[Combat] ${shooter.name} hit ${targetPlayer.name} for ${validatedDamage} (${newHealth} HP remaining)`);

      // Update room's player map
      const roomPlayer = room.players.get(finalTargetId);
      if (roomPlayer) {
        roomPlayer.health = newHealth;
        roomPlayer.alive = !died;
      }

      // Broadcast hit
      io.to(roomId).emit(SOCKET_EVENTS.PLAYER_HIT, {
        targetId: finalTargetId,
        shooterId: socket.id,
        damage: validatedDamage,
        newHealth,
      });

      if (died) {
        playerManager.addKill(socket.id);
        const shooterRoomPlayer = room.players.get(socket.id);
        if (shooterRoomPlayer) shooterRoomPlayer.kills += 1;
        const victimRoomPlayer = room.players.get(finalTargetId);
        if (victimRoomPlayer) victimRoomPlayer.deaths += 1;

        io.to(roomId).emit(SOCKET_EVENTS.PLAYER_DEATH, {
          victimId: finalTargetId,
          killerId: socket.id,
          killerName: shooter.name,
          victimName: target.name,
        });

        // Schedule respawn
        room.scheduleRespawn(finalTargetId);
      }
    } catch (err) {
      console.error('playerShoot error:', err);
    }
  });

  // ──────────────────────────────────────────────────────────
  // START MATCH
  // ──────────────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.START_MATCH, (payload: { roomId: string }) => {
    const { roomId } = payload;
    const room = gameManager.getRoom(roomId);
    if (!room) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      return;
    }
    if (room.hostId !== socket.id) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: 'Only the host can start the match', code: 'NOT_HOST' });
      return;
    }
    if (!room.canStart()) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: 'Cannot start match', code: 'CANNOT_START' });
      return;
    }
    room.startCountdown();
    console.log(`[Match] Starting countdown for room ${roomId}`);
  });
}

// ──────────────────────────────────────────────────────────
// Helper: Handle player leaving
// ──────────────────────────────────────────────────────────
function handlePlayerLeave(
  playerId: string,
  roomId: string,
  io: Server,
  gameManager: GameManager,
  playerManager: PlayerManager
): void {
  const player = playerManager.getPlayer(playerId);
  const room = gameManager.getRoom(roomId);

  if (!room) return;

  room.removePlayer(playerId);
  playerManager.removePlayer(playerId);

  console.log(`[Room] Player ${playerId} left room ${roomId} (${room.playerCount} remaining)`);

  if (room.playerCount === 0) {
    gameManager.deleteRoom(roomId);
    console.log(`[Room] Room ${roomId} destroyed (empty)`);
    return;
  }

  io.to(roomId).emit(SOCKET_EVENTS.PLAYER_LEFT, {
    playerId,
    newHostId: room.hostId,
    room: room.getRoomState(),
  });
}
