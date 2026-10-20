import * as User from 'xxscreeps/engine/db/user/index.js';
import { deleteSegments } from './model.js';

User.hooks.register('remove', deleteSegments);
