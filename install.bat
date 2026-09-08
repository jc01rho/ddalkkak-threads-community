@echo off
chcp 65001 >nul
echo ===================================================
echo   딸칵 Threads 공장 v1 - 설치를 시작합니다
echo ===================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 Node.js 22 이상을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

echo [1/5] Node.js 버전 확인
node --version

echo.
echo [2/5] claude CLI 확인 (없어도 설치는 계속 진행됩니다)
where claude >nul 2>nul
if errorlevel 1 (
  echo   경고: claude 명령을 찾을 수 없습니다. Claude Code를 설치/로그인한 뒤
  echo         "claude --version" 이 정상 동작하는지 확인하세요. (README_KO.md 참고)
) else (
  claude --version
)

echo.
echo [3/5] npm ci --ignore-scripts 실행 (package-lock.json 기준 정확한 버전 설치, 수 분 소요될 수 있습니다)
call npm ci --ignore-scripts
if errorlevel 1 (
  echo [오류] npm ci 실패. 인터넷 연결과 Node.js 버전을 확인하세요.
  pause
  exit /b 1
)

echo.
echo [4/5] TypeScript 빌드
call npm run build
if errorlevel 1 (
  echo [오류] TypeScript 빌드에 실패했습니다.
  pause
  exit /b 1
)

echo.
echo [5/5] 환경설정 파일(.env) 준비
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo   .env 파일을 새로 만들었습니다. (기본값: DRY_RUN=true, 실제 게시 안 함)
) else (
  echo   .env 파일이 이미 있어 건드리지 않았습니다.
)

if not exist "data" mkdir data
if not exist "logs" mkdir logs

echo.
echo ===================================================
echo   설치가 끝났습니다.
echo   다음 단계: start.bat 을 실행해 서버를 켜세요.
echo ===================================================
pause
