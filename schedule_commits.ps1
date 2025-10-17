# GitHub Streak Maintenance Script
# Run this script to create commits for future dates

param(
    [int]$DaysAhead = 7,
    [string]$StartDate = (Get-Date).ToString("yyyy-MM-dd")
)

Write-Host "Creating commits for $DaysAhead days starting from $StartDate"

for ($i = 0; $i -lt $DaysAhead; $i++) {
    $commitDate = (Get-Date $StartDate).AddDays($i).ToString("yyyy-MM-dd HH:mm:ss")
    $commitMessage = "Daily maintenance commit - $commitDate"
    
    Write-Host "Creating commit for $commitDate"
    
    # Create a small change (add timestamp to a file)
    $timestampFile = "maintenance_log.txt"
    Add-Content -Path $timestampFile -Value "Maintenance commit: $commitDate"
    
    # Stage and commit with future date
    git add $timestampFile
    git commit -m $commitMessage --date="$commitDate"
    
    Write-Host "Commit created for $commitDate"
}

Write-Host "All commits created! Push with: git push origin main"
