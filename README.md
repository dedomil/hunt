# hunt
backend api for mosaic (annual event) game by CodeX

### endpoints

- POST `/register` - register a team of 2-6 members
- POST `/login` - jwt based login
- GET `/question` - get the current question/clue
- POST `/question` - submit the answer for the clue
- POST `/refuel` - refuel the ship's health
- GET `/leaderboard` - get the leaderboard i.e. top teams
